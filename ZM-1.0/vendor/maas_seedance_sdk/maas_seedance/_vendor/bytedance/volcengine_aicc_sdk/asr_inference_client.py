"""
DeepSeek机密推理客户端
"""
__all__ = ["ASRClient"]

import json
import uuid
import requests
import bytedance.jeddak_secure_channel as jsc
from typing import IO, Union
from .aicc_inference import AICCInference
from .common.constant import Constants
from .common.error import AICCException
from .common.log import logger
from .common.utils import file_to_base64


class ASRClient(AICCInference):
    """
    ASR客户端.
    """

    def __init__(self,
                 base_url: str = None,
                 aicc_service_name: str = None,
                 policy_id: str = None,
                 is_openai: bool = True,
                 is_secure: bool = True,
                 ak: str = None,
                 sk: str = None,
                 region: str = "cn-beijing",
                 **kwargs):
        appid = kwargs.get("appid")
        token = kwargs.get("token")
        service_id = kwargs.get("service_id")

        if not base_url or not appid or not token or not service_id or not \
                aicc_service_name or not policy_id or not ak or not sk:
            raise AICCException("New deepseek client failed, params error")

        super().__init__(base_url, is_openai, is_secure, ak, sk, region)

        self.appid = appid
        self.token = token
        self.service_id = service_id

        self.aicc_service_name = aicc_service_name
        self.policy_id = policy_id

        self.kwargs = kwargs

        self.jsc_client = None
        self.max_retries = 3

        if is_secure:
            jsc_config = dict()
            jsc_config["ra_service_name"] = aicc_service_name
            jsc_config["ra_policy_id"] = policy_id
            jsc_config["bytedance_top_info"] = dict()
            jsc_config["bytedance_top_info"]["ak"] = ak
            jsc_config["bytedance_top_info"]["sk"] = sk
            jsc_config["bytedance_top_info"]["region"] = region
            jsc_config["bytedance_top_info"]["url"] = self.kwargs.get("top_url", "open.volcengineapi.com")
            jsc_config["bytedance_top_info"]["service"] = self.kwargs.get("top_service", "pcc")
            jsc_config["log_config"] = self.kwargs.get("log_config", Constants.LOG_CONFIG)

            try:
                secure_channel_config = jsc.ClientConfig.from_dict(jsc_config)
                self.jsc_client = jsc.Client(secure_channel_config)
            except Exception as e:
                logger.error(f"Error init jsc: {e}")
                raise AICCException("New deepseek client failed")

    def chat_completions(self, messages: list, output_stream: IO = None) -> Union[str, None]:
        """
        生成聊天补全
        :param messages:
        :param output_stream:
        :return:
        """
        pass

    def function_call(self, messages: list, tools: list, output_stream: IO = None) -> str:
        """
        :param messages:
        :param tools:
        :param output_stream:
        :return:
        """
        pass

    def asr_recognize(self, file_name: str) -> Union[str, None]:
        if not file_name:
            raise AICCException("ASR asr_recognize file_name cannot be empty")

        appid = self.appid
        token = self.token
        service_id = self.service_id
        model_name = "bigmodel"

        if self.base_url.endswith("flash"):
            recognize_url = self.base_url
        else:
            if self.is_secure:
                recognize_url = f"{self.base_url}/api/v2/auc/{model_name}/recognize/flash"
            else:
                recognize_url = f"{self.base_url}/api/v1/auc/{model_name}/recognize/flash"

        try:
            audio_data = None
            enc_base64_data = file_to_base64(file_name)  # 转换文件为 Base64

            # 将转换后的base64数据写入文件
            enc_key = None
            if self.is_secure:
                enc_base64_data, enc_key = self.jsc_client.encrypt_with_response(enc_base64_data)

            audio_data = {
                "data": enc_base64_data,
            }

            headers = {
                "X-Api-App-Id": appid,
                "X-Api-App-Key": token,
                "X-Api-Aicc-Endpoint": service_id,
                "X-Api-Request-Id": str(uuid.uuid4()),
            }

            if not audio_data:
                raise AICCException("必须提供ASR文件内容")

            request = {
                "audio": audio_data,
                "request": {
                    "model_name": model_name,
                },
            }

            response = requests.post(recognize_url, json=request, headers=headers)
            if response.status_code == 200:  # task finished
                result = response.json()
                content = result["result"]
                if self.is_secure and enc_key:
                    content = enc_key.decrypt(content)
                    # 检查 content 类型，如果是 bytes 则解码，否则直接使用
                    if isinstance(content, bytes):
                        content = json.loads(content.decode("utf-8"))
                    else:
                        content = json.loads(content)
                result["result"] = content
                return json.dumps(result)
            else:
                raise AICCException("ASR处理失败")
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"call AICC ASR service asr_recognize error: {e}")
            raise AICCException("AICC ASR service asr_recognize error")
