"""
seedance机密推理客户端
"""
__all__ = ["SeedanceClient"]

import os
import base64
import requests
import traceback
from urllib.parse import unquote
from cryptography.hazmat.primitives import serialization as crypto_serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.backends import default_backend as crypto_default_backend
from bytedance.jeddak_secure_channel.crypto import PrivateKey
from .secure_http_client import SecureHttpClient
from .common.tos_utils import TOSUtils
from .common.error import AICCException
from .common.log import logger
from .secure_http_client import AICCConfig
from .common.aes import decrypt_file


class SeedanceClient:
    """
    DeepSeek机密推理客户端.
    """

    def __init__(self,
                 base_url: str = "",
                 api_key: str = "",
                 endpoint: str = "",
                 aicc_config: AICCConfig = None,
                 **kwargs):
        self.base_url = base_url
        self.api_key = api_key
        self.endpoint = endpoint
        self.aicc_config = aicc_config
        self.tos_utils = TOSUtils()
        self.kwargs = kwargs
        self.is_secure = self.kwargs.get("is_secure", True)

        if aicc_config:
            self.secure_http_client = SecureHttpClient(aicc_config=aicc_config)
        else:
            if self.is_secure:
                aicc_config = AICCConfig(ra_url=base_url, auth_token=api_key)
                self.secure_http_client = SecureHttpClient(aicc_config=aicc_config)
            else:
                self.secure_http_client = SecureHttpClient()

        # 是否开启视频文件加密, 默认加密
        self.is_enable_video_encrypt = str(self.kwargs.get("is_enable_video_encrypt", True)).lower() == "true"

        # 视频文件的存储位置, 目前仅支持火山TOS
        self.video_file_storage_location = self.kwargs.get("video_file_storage_location", "TOS").upper()

        self.video_file_encrypt_pub_key_content = None
        self.video_file_encrypt_priv_key_content = None

        self.video_file_encrypt_priv_key: PrivateKey = None

        self.timeout = self.kwargs.get("timeout", 120.0)

        # API Endpoints
        self.CREATE_TASK_URL = "/contents/generations/tasks"
        self.QUERY_TASK_URL = "/contents/generations/tasks"
        self.QUERY_TASK_LIST_URL = "/contents/generations/tasks"
        self.DELETE_TASK_URL = "/contents/generations/tasks"

    def _get_base_url(self):
        """
        Get base URL with trailing slash removed
        """
        return self.base_url.rstrip("/")

    def set_video_file_encrypt_key(self, pub_key_path: str = "", priv_key_path: str = ""):
        """
        Set video file encrypt key
        Args:
            pub_key_path: Public key for encrypt
            priv_key_path: Private key for decrypt
        """
        if os.path.exists(pub_key_path):
            with open(pub_key_path, 'r') as f:
                content = f.read()
                if '-----BEGIN' in content and '-----END' in content:
                    self.video_file_encrypt_pub_key_content = content

        if os.path.exists(priv_key_path):
            with open(priv_key_path, 'r') as f:
                content = f.read()
                if '-----BEGIN' in content and '-----END' in content:
                    self.video_file_encrypt_priv_key_content = content
                    self.video_file_encrypt_priv_key = \
                        PrivateKey.from_private_pem(self.video_file_encrypt_priv_key_content)

    def _generate_key_pair(self, pub_key_path: str = "", priv_key_path: str = ""):
        """
        Generate RSA 4096 key pair and save to files

        Args:
            pub_key_path: Path to save public key
            priv_key_path: Path to save private key

        Returns:
            Tuple of (public_key_path, private_key_path)
        """
        try:
            # Generate RSA key pair
            key = rsa.generate_private_key(
                backend=crypto_default_backend(),
                public_exponent=65537,
                key_size=4096
            )

            # Save private key
            private_key = key.private_bytes(
                crypto_serialization.Encoding.PEM,
                crypto_serialization.PrivateFormat.PKCS8,
                crypto_serialization.NoEncryption()
            )
            with open(priv_key_path, 'wb') as f:
                f.write(private_key)

            # Save public key
            public_key = key.public_key().public_bytes(
                crypto_serialization.Encoding.PEM,
                crypto_serialization.PublicFormat.SubjectPublicKeyInfo
            )
            with open(pub_key_path, 'wb') as f:
                f.write(public_key)
        except Exception as e:
            logger.error(f"[Error] Failed to generate key pair: {e}")
            raise AICCException("Failed to generate RSA key pair") from e

    def generate_video_file_encrypt_key(self, pub_key_path: str = "", priv_key_path: str = ""):
        """
        Generate video file encrypt key
        Args:
            pub_key_path: Public key for encrypt
            priv_key_path: Private key for decrypt
        """
        # 如果没有提供路径报错
        if not pub_key_path or not priv_key_path:
            raise ValueError("pub_key_path and priv_key_path must be provided")
        
        self._generate_key_pair(pub_key_path, priv_key_path)
        # self.set_video_file_encrypt_key(pub_key_path, priv_key_path)

    def create_video_generation_task(self, data: dict, custom_header: dict = None) -> str:
        """
        :param data:
        :param custom_header:
        :return:
        """
        if not data:
            raise AICCException("data must be provided")

        if "model" not in data:
            data["model"] = self.endpoint

        base_url = self._get_base_url()
        url = f"{base_url}{self.CREATE_TASK_URL}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }
        if custom_header:
            headers.update(custom_header)

        # Add encryption headers if provided
        if self.is_enable_video_encrypt:
            if not self.video_file_encrypt_pub_key_content or not self.video_file_encrypt_priv_key_content:
                raise AICCException("pub_key and priv_key must be provided when Is-Enable-Encrypt is 'true'")

            headers["Enable-TOS-Content-Result-Encryption"] = str(self.is_enable_video_encrypt).lower()
            headers["X-Encryption-Algorithm"] = "RSA_OAEP_4096_AES_256"
            if self.video_file_encrypt_pub_key_content:
                # Base64 encode the PEM public key for safe HTTP header transmission
                # This avoids issues with newlines and special characters in headers
                pk_base64 = base64.b64encode(self.video_file_encrypt_pub_key_content.encode()).decode()
                headers["PK"] = pk_base64

        # logger.info(f"[Request] Data: {json.dumps(data, ensure_ascii=False, indent=2)}")

        response = self.secure_http_client.post(url, headers=headers, json=data, timeout=self.timeout)
        if response.status_code == 200:
            result = response.json()
            task_id = result.get("id")
            return task_id
        else:
            logger.error(f"[Error] url: {url}, response: {response.text}")
            return ""

    def create_video_generation_task_by_message(self, message: list, custom_header: dict = None,
                                                generate_audio: bool = True,
                                                ratio: str = "16:9", duration: int = 11,
                                                watermark: bool = False) -> str:
        """
           message: List of messages to generate video
        """
        if not message:
            raise AICCException("message must be provided")

        data = {
            "model": self.endpoint,
            "content": message,
            "generate_audio": generate_audio,
            "ratio": ratio,
            "duration": duration,
            "watermark": watermark
        }
        return self.create_video_generation_task(data, custom_header)

    def query_video_generation_task(self, task_id: str) -> dict:
        """
        Query video generation task
        API: GET /api/v3/contents/generations/tasks/{task_id}
        """

        if not task_id:
            raise AICCException("task_id must be provided")

        base_url = self._get_base_url()
        url = f"{base_url}{self.QUERY_TASK_URL}/{task_id}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }

        # logger.info(f"[Request] URL: {url}")

        # response = self.secure_http_client.get(url, headers=headers, timeout=self.timeout)
        response = self.secure_http_client.request(
            "GET", url, headers=headers, content=b"{}", timeout=self.timeout
        )

        if response.status_code == 200:
            result = response.json()
            # logger.info(f"[Response] Body: {json.dumps(result, ensure_ascii=False, indent=2)}")

            # status = result.get("status")
            # if status == "succeeded":
            #     video_url = result.get("content", {}).get("video_url")
            #     print(f"[Video URL] {video_url}")

            return result
        else:
            try:
                result = response.json()
                return result
            except Exception as e:
                logger.error(f"[Error] url: {url}, Exception={e}")
                raise AICCException(f"Failed to query video generation task")

    def query_video_generation_task_list(
            self,
            page_num: int = 0,
            page_size: int = 0,
            status: str = "",
            task_ids: list = None,
            model: str = "",
            service_tier: str = ""
    ) -> dict:
        """
        Query video generation task list
        API: GET /api/v3/contents/generations/tasks

        Args:
            page_num: Page number (only added if > 0)
            page_size: Page size (only added if > 0)
            status: Filter by status (only added if not empty)
            task_ids: Filter by task IDs (only added if not empty list)
            model: Filter by model (only added if not empty)
            service_tier: Filter by service tier (only added if not empty)

        Returns:
            Query result dict
        """
        from urllib.parse import urlencode

        base_url = self._get_base_url()

        # Build query parameters (only add non-empty values)
        params = []

        if page_num > 0:
            params.append(f"page_num={page_num}")

        if page_size > 0:
            params.append(f"page_size={page_size}")

        if status:
            params.append(f"filter.status={status}")

        if task_ids and len(task_ids) > 0:
            for task_id in task_ids:
                params.append(f"filter.task_ids={task_id}")

        if model:
            params.append(f"filter.model={model}")

        if service_tier:
            params.append(f"filter.service_tier={service_tier}")

        # Build URL with query parameters
        query_string = "&".join(params)
        if query_string:
            url = f"{base_url}{self.QUERY_TASK_LIST_URL}?{query_string}"
        else:
            url = f"{base_url}{self.QUERY_TASK_LIST_URL}"

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }

        response = self.secure_http_client.get(url, headers=headers, timeout=self.timeout)
        try:
            result = response.json()
            return result
        except Exception as e:
            logger.error(f"query_video_generation_task_list error: {e}")
            raise AICCException(f"Failed to query video generation task list")

    def delete_video_generation_task(self, task_id: str):
        """
        Delete video generation task
        API: DELETE /api/v3/contents/generations/tasks/{task_id}
        """
        if not task_id:
            raise AICCException("task_id must be provided")

        base_url = self._get_base_url()
        url = f"{base_url}{self.DELETE_TASK_URL}/{task_id}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        }
        response = self.secure_http_client.delete(url, headers=headers, timeout=self.timeout)
        try:
            result = response.json()
            return result
        except Exception as e:
            logger.error(f"delete_video_generation_task error: {e}")
            raise AICCException(f"Failed to delete_video_generation_task")

    def video_file_download(self, task_id: str, video_file_path: str) -> bool:
        """
        Download and decrypt encrypted video
        This function polls the task status until it succeeds, then downloads
        and decrypts the video using the provided private key.
        Args:
            task_id: Video generation task ID
            video_file_path: Directory to save decrypted video

        Returns:
            Path to decrypted video file, or None if failed
        """
        if not task_id:
            raise AICCException("task_id must be provided")

        if not video_file_path:
            raise AICCException("video_file_path must be provided")

        result = self.query_video_generation_task(task_id)
        if not result:
            logger.error(f"[Error] Failed to query task,task_id={task_id}")
            return False

        status = result.get("status")
        if status == "succeeded":
            video_url = result.get("content", {}).get("video_url")
            if not video_url:
                logger.error("[Error] No video_url in response")
                return False

            return self.download_file_normal(video_url, video_file_path)
            # encrypted_key = b""
            # if self.is_enable_video_encrypt:
            #     encrypted_key = result.get("encrypted_key")
            #     if not encrypted_key:
            #         logger.error("[Error] No encrypted_key in response")
            #         return False
            #     if not self.video_file_encrypt_priv_key:
            #         logger.error("[Error] No private key set, cannot decrypt encrypted video")
            #         return False
            #     else:
            #         # Base64 decode the encrypted key before RSA decryption
            #         encrypted_key_bytes = base64.b64decode(encrypted_key)
            #         encrypted_key = self.video_file_encrypt_priv_key.decrypt(encrypted_key_bytes)
            #
            # logger.info(f"\n[Downloading] Starting download and decryption...")
            #
            # try:
            #     if self.video_file_storage_location == "TOS":
            #         self.tos_utils.download_file(tos_url=video_url, local_file_path=video_file_path,
            #                                       encrypted_key=encrypted_key)
            #     else:
            #         logger.error(f"[Error] Unsupported video storage location: {self.video_file_storage_location}")
            #         return False
            #
            #     logger.info(f"\n[Success] Decrypted video saved to: {video_file_path}")
            #     return True
            #
            # except Exception as e:
            #     logger.error(f"[Error] Download and decryption failed: {str(e)}")
            #     return False

        elif status == "failed":
            error_info = result.get("error", "Unknown error")
            logger.error(f"[Error] Task failed: {error_info}")
            return False

        elif status in ["pending", "running", "queued"]:
            logger.info(f"[Waiting] Task is {status}, please wait for it to finish...")
            return False
        else:
            logger.warning(f"[Warning] Unknown status: {status}")
            return False

    def video_file_download_by_url(self, video_url: str, video_file_path: str) -> bool:
        """
        Download and decrypt encrypted video
        This function polls the task status until it succeeds, then downloads
        and decrypts the video using the provided private key.
        Args:
            video_url: Video video_url
            video_file_path: Directory to save decrypted video

        Returns:
            Path to decrypted video file, or None if failed
        """
        if not video_url:
            raise AICCException("video_url must be provided")

        if not video_file_path:
            raise AICCException("video_file_path must be provided")

        logger.info(f"\n[Downloading] Starting download and decryption...")

        try:
            return self.download_file_normal(video_url, video_file_path)
        except Exception as e:
            logger.error(f"[Error] Download and decryption failed: {str(e)}")
            return False

    def download_file_normal(self, video_url: str, video_file_path: str) -> bool:
        """
        Download video file
        Args:
            video_url: Video video_url
            video_file_path: Directory to save video file

        Returns:
            Path to video file, or None if failed
        """
        if not video_url:
            raise AICCException("video_url must be provided")

        if not video_file_path:
            raise AICCException("video_file_path must be provided")

        if os.path.exists(video_file_path) and os.path.getsize(video_file_path) > 0:
            logger.error(f"[Error] File {video_file_path} already exists and is not empty")
            return False

        try:
            response = requests.get(video_url, stream=True)
            with open(video_file_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            if self.is_enable_video_encrypt:
                if not self.video_file_encrypt_priv_key:
                    logger.error("[Error] No private key set, cannot decrypt encrypted video")
                    return False

                headers = response.headers
                encrypted_key = headers.get("x-tos-meta-enc-dek")
                # nonce = headers.get("x-tos-meta-x-tos-meta-base-nonce")
                if not encrypted_key:
                    logger.error("[Error] No encrypted_key in response")
                    return False

                try:
                    encrypted_key_bytes = base64.b64decode(unquote(encrypted_key))
                    encrypted_key = self.video_file_encrypt_priv_key.decrypt(encrypted_key_bytes)
                    tmp_file_path = video_file_path + ".tmp"
                    decrypt_file(encrypted_key, video_file_path, tmp_file_path, 'b')
                    os.remove(video_file_path)
                    os.rename(tmp_file_path, video_file_path)
                except Exception as e:
                    logger.error(f"[Error] Failed to decode encrypted_key: {e}")
                    return False
        except Exception as e:
            logger.error(f"[Error] Download failed: {e}")
            traceback.print_exc()
            return False
        return True
