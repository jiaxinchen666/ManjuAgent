"""
CU开源模型机密推理客户端
"""
__all__ = ["CUClient"]

import base64
import json
import time
import requests
import bytedance.jeddak_secure_channel as jsc
from typing import IO, Union
from .aicc_inference import AICCInference
from .common.constant import Constants
from .common.error import AICCException
from .common.log import logger


class CUClient(AICCInference):
    """
    AICC机密推理访问客户端.
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
        if not base_url or not aicc_service_name or not policy_id or not ak or not sk:
            raise AICCException(f"New CU client failed, params error")

        super().__init__(base_url, is_openai, is_secure, ak, sk, region)

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
                raise AICCException("create cu client failed")

    def completions(self, prompt: str, output_stream: IO = None) -> Union[str, None]:
        """
        生成聊天补全
        :param prompt:
        :param output_stream:
        :return:
        """
        if not prompt:
            raise AICCException("vllm completions Prompt cannot be empty")

        try:
            if self.is_secure:
                url = f"{self.base_url}/v2/completions"
            else:
                url = f"{self.base_url}/v1/completions"

            headers = {"Content-Type": "application/json"}
            payload = {
                "prompt": prompt,
                "max_tokens": int(self.kwargs.get("max_tokens", 100)),
                "temperature": float(self.kwargs.get("temperature", 1.0)),
                "stream": True if output_stream else False
            }

            encrypt_key = None
            if self.is_secure:
                # 加密数据并发送
                try:
                    encrypted_prompt, encrypt_key = self.jsc_client.encrypt_with_response(json.dumps(payload["prompt"]))
                    payload["prompt"] = encrypted_prompt  # 敏感字段
                except Exception as e:
                    logger.error(f"Error during encrypt: {e}")
                    raise AICCException("error during encrypt")

            if output_stream:
                try:
                    # 启用流式响应
                    with requests.post(url, json=payload, headers=headers, stream=True) as response:
                        response.raise_for_status()
                        for chunk in response.iter_lines():
                            if chunk:
                                if self.is_secure and encrypt_key:
                                    data = encrypt_key.decrypt(base64.b64decode(chunk))
                                    output_stream.write(f"{data}")
                                else:
                                    output_stream.write(f"{chunk}")
                except Exception as e:
                    logger.error(f"call AICC VLLM service completions stream error:{e}")
                    raise AICCException("vllm completions_stream error")
            else:
                for attempt in range(self.max_retries):
                    try:
                        response = requests.post(url, json=payload, headers=headers)
                        response.raise_for_status()
                        data = response.json()

                        if self.is_secure and encrypt_key:
                            for elm in data['choices']:
                                elm['text'] = encrypt_key.decrypt(elm['text']).decode()

                        return json.dumps(data)
                    except Exception as e:
                        if attempt == self.max_retries - 1:
                            logger.error(f"call AICC VLLM service completions error:{e}")
                            raise AICCException("call vllm completions error")
                        else:
                            logger.error(f"call AICC VLLM service completions error:{e}, try again....")
                            time.sleep(1)
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"completions error,Exception={e}")
            raise AICCException("completions error")

    def completions_stream(self, prompt: str, output_stream: IO) -> Union[str, None]:
        return self.completions(prompt, output_stream)

    def chat_completions(self, messages: list, output_stream: IO = None) -> Union[str, None]:
        """
        生成聊天补全
        :param messages:
        :param output_stream:
        :return:
        """
        try:
            if not messages:
                raise AICCException("vllm chat_completions Messages cannot be empty")

            if self.is_secure:
                url = f"{self.base_url}/v2/chat/completions"
            else:
                url = f"{self.base_url}/v1/chat/completions"

            headers = {"Content-Type": "application/json"}
            payload = {
                "messages": messages,
                "max_tokens": int(self.kwargs.get("max_tokens", 100)),
                "temperature": float(self.kwargs.get("temperature", 1.0)),
                "stream": True if output_stream else False  # 启用流式响应
            }

            encrypt_key = None
            if self.is_secure:
                # 加密数据并发送
                try:
                    encrypted_messages, encrypt_key = \
                        self.jsc_client.encrypt_with_response(json.dumps(payload["messages"]))
                    payload["messages"] = encrypted_messages  # 敏感字段
                except Exception as e:
                    logger.error(f"Error during encrypt: {e}")
                    raise AICCException("Error during encrypt")

            if output_stream:
                with requests.post(url, json=payload, headers=headers, stream=True) as response:
                    response.raise_for_status()
                    for chunk in response.iter_lines():
                        if chunk:
                            if self.is_secure and encrypt_key:
                                data = encrypt_key.decrypt(base64.b64decode(chunk))
                                output_stream.write(f"{data}")
                            else:
                                output_stream.write(f"{chunk}")
            else:
                for attempt in range(self.max_retries):
                    try:
                        response = requests.post(url, json=payload, headers=headers)
                        response.raise_for_status()
                        data = response.json()

                        if self.is_secure and encrypt_key:
                            for elm in data['choices']:
                                elm['message'] = json.loads(encrypt_key.decrypt(elm['message']))

                        return json.dumps(data)
                    except Exception as e:
                        if attempt == self.max_retries - 1:
                            logger.error(f"call AICC VLLM service chat_completions error:{e}")
                            raise AICCException("vllm chat_completions error")
                        else:
                            logger.error(f"call AICC VLLM service chat_completions error:{e}, try again....")
                            time.sleep(1)
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"call AICC VLLM service chat_completions error: {e}")
            raise AICCException("AICC VLLM service chat_completions error")

    def chat_completions_stream(self, messages: list, output_stream: IO) -> Union[str, None]:
        return self.chat_completions(messages, output_stream)

    def function_call(self, messages: list, tools: list, output_stream: IO = None):
        """
        :param messages:
        :param tools:
        :param output_stream:
        :return:
        """
        error_info = "Sorry, this version does not support function_call at this time."
        logger.error(error_info)
        raise AICCException(error_info)

    def function_call_stream(self, messages: list, tools: list, output_stream: IO):
        return self.function_call(messages, tools, output_stream)

    def asr_recognize(self, file_name: str) -> Union[str, None]:
        error_info = "Sorry, this version does not support asr at this time."
        logger.error(error_info)
        return error_info
