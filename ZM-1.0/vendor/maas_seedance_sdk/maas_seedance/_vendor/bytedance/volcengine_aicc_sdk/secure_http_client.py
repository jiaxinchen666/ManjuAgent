import httpx
from typing import Optional, Tuple
from urllib.parse import urlparse
from bytedance.jeddak_secure_channel import ResponseKey
import bytedance.jeddak_secure_channel as jsc
from .common.error import AICCException
from .common.log import logger


class AICCConfig:
    """AICC 安全通信配置类"""

    def __init__(self,
                 ak: str = "",
                 sk: str = "",
                 aicc_llm_service_name: str = "AICC.ConfidentialInference",
                 policy_id: str = "router_policy",
                 region: str = "cn-beijing",
                 top_url: str = "pcc.volcengineapi.com",
                 top_service: str = "pcc",
                 ra_url: str = "",
                 auth_token: str = "",
                 **kwargs):
        """
        :param ak: 火山引擎用户的ak
        :param sk: 火山引擎用户的sk
        :param aicc_llm_service_name: aicc推理服务的服务名称
        :param policy_id: aicc推理服务做远程证明锁对应的policy
        :param region: aicc推理服务所在的区域
        :param service: aicc推理服务TOP网关的service
        :param ra_url: 非TCA接口时的RA接口地址
        :param auth_token: 非TCA接口时的鉴权凭据
        :param kwargs:
        """
        self.ak = ak
        self.sk = sk
        self.aicc_llm_service_name = aicc_llm_service_name
        self.policy_id = policy_id
        self.region = region
        self.top_url = top_url
        self.top_service = top_service
        self.ra_url = ra_url
        self.auth_token = auth_token

        self.kwargs = kwargs

        self.HTTP_RA_PATH = "v1/security/token"
        if self.ra_url:
            parsed = urlparse(self.ra_url)
            base_domain = f"{parsed.scheme}://{parsed.netloc}"
            self.ra_url = f"{base_domain}/{self.HTTP_RA_PATH}"

    def to_dict(self) -> dict:
        """将配置对象转换为字典格式

        :return: 包含所有配置项的字典
        """
        config_dict = {
            "ak": self.ak,
            "sk": self.sk,
            "aicc_llm_service_name": self.aicc_llm_service_name,
            "policy_id": self.policy_id,
            "region": self.region,
            "top_url": self.top_url,
            "top_service": self.top_service,
            "ra_url": self.ra_url,
            "auth_token": self.auth_token
        }

        # 添加额外的 kwargs
        if self.kwargs:
            config_dict.update(self.kwargs)

        return config_dict

    def get_jsc_config(self) -> dict:
        """生成aicc端云互信配置
        """
        jsc_config = dict()
        jsc_config["ra_url"] = self.ra_url
        jsc_config["auth_token"] = self.auth_token
        jsc_config["ra_service_name"] = self.aicc_llm_service_name
        jsc_config["ra_policy_id"] = self.policy_id

        if self.ak and self.sk:
            jsc_config["bytedance_top_info"] = dict()
            jsc_config["bytedance_top_info"]["ak"] = self.ak
            jsc_config["bytedance_top_info"]["sk"] = self.sk
            jsc_config["bytedance_top_info"]["region"] = self.region
            jsc_config["bytedance_top_info"]["url"] = self.top_url
            jsc_config["bytedance_top_info"]["service"] = self.top_service

        return jsc_config


AICC_SDK_VERSION = "0.1.0"
jsc_clients = dict()


class DemoSyncByteStream(httpx.SyncByteStream):
    def __init__(self, raw_stream, encrypt_key: ResponseKey = None) -> None:
        self._raw_stream = raw_stream
        self.encrypt_key = encrypt_key
        self.buffer = b""

    def __iter__(self):
        for part in self._raw_stream:
            if not isinstance(part, bytes):
                part = part.encode("utf-8")

            for line in part.splitlines(keepends=True):
                self.buffer += line
                if self.buffer.endswith((b"\r", b"\n")):
                    cipher_events = self.encrypt_key.decrypt(self.buffer.strip())
                    cipher_events += b"\n" if self.buffer[-1] == 10 else b""  # 10 == "\n"
                    self.buffer = b""
                    yield cipher_events

        if self.buffer:
            yield self.buffer

    def close(self) -> None:
        if hasattr(self._raw_stream, "close"):
            self._raw_stream.close()


class DemoAsyncByteStream(httpx.AsyncByteStream):
    def __init__(self, raw_stream, encrypt_key: ResponseKey = None) -> None:
        self._raw_stream = raw_stream
        self.encrypt_key = encrypt_key
        self.buffer = b""

    async def __aiter__(self):
        async for part in self._raw_stream:
            if not isinstance(part, bytes):
                part = part.encode("utf-8")

            for line in part.splitlines(keepends=True):
                self.buffer += line
                if self.buffer.endswith((b"\r", b"\n")):
                    cipher_events = self.encrypt_key.decrypt(self.buffer.strip())
                    cipher_events += b"\n" if self.buffer[-1] == 10 else b""  # 10 == "\n"
                    self.buffer = b""
                    yield cipher_events

        if self.buffer:
            yield self.buffer

    async def aclose(self) -> None:
        if hasattr(self._raw_stream, "aclose"):
            await self._raw_stream.aclose()
        elif hasattr(self._raw_stream, "close"):
            self._raw_stream.close()


class SecureHttpClient(httpx.Client):
    def __init__(self, *args, **kwargs):
        self.aicc_config: Optional[AICCConfig] = None

        if kwargs.get("aicc_config"):
            try:
                self.aicc_config = kwargs.pop("aicc_config")
                secure_channel_config = jsc.ClientConfig.from_dict(self.aicc_config.get_jsc_config())
                jsc_clients[self.aicc_config.aicc_llm_service_name] = jsc.Client(secure_channel_config)
            except Exception as e:
                logger.error(f"Error init jsc, aicc_llm_service_name={self.aicc_config.aicc_llm_service_name}, {e}")
                self.aicc_config = None
                raise AICCException("New deepseek client failed")

        super().__init__(*args, **kwargs)

    def jsc_encryption(self, msg: bytes) -> Tuple[str, ResponseKey]:
        encrypt_key: Optional[ResponseKey] = None

        if self.aicc_config:
            jsc_client = jsc_clients.get(self.aicc_config.aicc_llm_service_name)
            if jsc_client:
                msg, encrypt_key = jsc_client.encrypt_with_response(msg)

        return msg, encrypt_key

    def send(self, request: httpx.Request, *args, **kwargs):
        encrypt_key: Optional[ResponseKey] = None

        if self.aicc_config:
            request.headers["X-AICC-Encryption-Enable"] = "true"
            request.headers["X-AICC-Encryption-SDK"] = "aicc"
            request.headers["X-AICC-Encryption-Version"] = AICC_SDK_VERSION

            encryption_content, encrypt_key = self.jsc_encryption(request.content)
            if isinstance(encryption_content, str):
                encryption_content = encryption_content.encode("utf-8")

            request.stream = httpx.ByteStream(encryption_content)
            delattr(request, "_content")
            request.headers["Content-Type"] = "application/json"
            request.headers["Content-Length"] = str(len(encryption_content))
            request.read()

        resp = super().send(request, *args, **kwargs)

        if 200 <= resp.status_code < 300:
            if encrypt_key:
                if not kwargs.get("stream", False):
                    content = resp.content
                    decrypted_content = encrypt_key.decrypt(content)
                    resp._content = decrypted_content
                else:
                    resp.stream = DemoSyncByteStream(resp.stream, encrypt_key)
        else:
            if encrypt_key:
                try:
                    if not kwargs.get("stream", False):
                        content = resp.content
                        decrypted_content = encrypt_key.decrypt(content)
                        resp._content = decrypted_content
                    else:
                        resp.stream = DemoSyncByteStream(resp.stream, encrypt_key)
                except Exception as e:
                    pass
        return resp


class AsyncSecureHttpClient(httpx.AsyncClient):
    def __init__(self, *args, **kwargs):
        self.aicc_config: Optional[AICCConfig] = None

        if kwargs.get("aicc_config"):
            try:
                self.aicc_config = kwargs.pop("aicc_config")
                secure_channel_config = jsc.ClientConfig.from_dict(self.aicc_config.get_jsc_config())
                jsc_clients[self.aicc_config.aicc_llm_service_name] = jsc.Client(secure_channel_config)
            except Exception as e:
                logger.error(f"Error init jsc, aicc_llm_service_name={self.aicc_config.aicc_llm_service_name}, {e}")
                self.aicc_config = None
                raise AICCException("New async secure client failed")

        super().__init__(*args, **kwargs)

    def jsc_encryption(self, msg: bytes) -> Tuple[str, ResponseKey]:
        encrypt_key: Optional[ResponseKey] = None

        if self.aicc_config:
            jsc_client = jsc_clients.get(self.aicc_config.aicc_llm_service_name)
            if jsc_client:
                msg, encrypt_key = jsc_client.encrypt_with_response(msg)

        return msg, encrypt_key

    async def send(self, request: httpx.Request, *args, **kwargs):
        encrypt_key: Optional[ResponseKey] = None

        if self.aicc_config:
            request.headers["X-AICC-Encryption-Enable"] = "true"
            request.headers["X-AICC-Encryption-SDK"] = "aicc"
            request.headers["X-AICC-Encryption-Version"] = AICC_SDK_VERSION

            encryption_content, encrypt_key = self.jsc_encryption(request.content)
            if isinstance(encryption_content, str):
                encryption_content = encryption_content.encode("utf-8")

            request.stream = httpx.ByteStream(encryption_content)
            delattr(request, "_content")
            request.headers["Content-Type"] = "application/json"
            request.headers["Content-Length"] = str(len(encryption_content))

        resp = await super().send(request, *args, **kwargs)

        if 200 <= resp.status_code < 300:
            if encrypt_key:
                if not kwargs.get("stream", False):
                    content = await resp.aread()
                    decrypted_content = encrypt_key.decrypt(content)
                    resp._content = decrypted_content
                else:
                    resp.stream = DemoAsyncByteStream(resp.stream, encrypt_key)
        else:
            if encrypt_key:
                try:
                    if not kwargs.get("stream", False):
                        content = await resp.aread()
                        decrypted_content = encrypt_key.decrypt(content)
                        resp._content = decrypted_content
                    else:
                        resp.stream = DemoAsyncByteStream(resp.stream, encrypt_key)
                except Exception as e:
                    pass
        return resp
