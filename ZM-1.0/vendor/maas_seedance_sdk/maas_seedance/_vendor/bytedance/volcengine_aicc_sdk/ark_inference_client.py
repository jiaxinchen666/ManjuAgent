"""
机密豆包客户端
"""
__all__ = ["ARKClient"]

import copy
import json
import os
from typing import IO, Union

from volcenginesdkarkruntime import Ark
from volcenginesdkarkruntime._utils._key_agreement import (
    aes_gcm_encrypt_base64_string, 
    aes_gcm_decrypt_base64_string, 
    key_agreement_client
)
from openai import OpenAI
from volcenginesdkarkruntime.types.chat import ChatCompletion, ChatCompletionChunk

from .aicc_inference import AICCInference
from .common.error import AICCException
from .common.log import logger


class ARKClient(AICCInference):
    """
    机密豆包客户端.
    """

    def __init__(self,
                 base_url: str = None,
                 api_key: str = None,
                 ep: str = None,
                 is_openai: bool = False,
                 is_secure: bool = True,
                 thinking_type: str = "disabled",
                 ak: str = None,
                 sk: str = None,
                 region: str = "cn-beijing",
                 **kwargs):
        if not base_url or not api_key or not ep:
            raise AICCException(f"New ARK client failed, base_url={base_url}, api_key={api_key}, ep={ep}")

        super().__init__(base_url, is_openai, is_secure, ak, sk, region)

        os.environ["VOLC_ARK_ENCRYPTION"] = "AICC"

        self.base_url = base_url
        self.api_key = api_key
        self.ep = ep
        self.is_openai = is_openai
        self.is_secure = is_secure
        self.thinking_type = thinking_type

        self.kwargs = kwargs

        self.client = None
        try:
            self.client = Ark(api_key=api_key, base_url=base_url, ak=ak, sk=sk, region=region)
        except Exception as e:
            logger.error(f"New ARK client failed: {e}")
            raise AICCException("New ARK client failed")

    def _chat_completion_to_str(self, chat_completion: ChatCompletion) -> str:
        ret = dict()
        ret["id"] = chat_completion.id
        ret["object"] = chat_completion.object
        ret["created"] = chat_completion.created
        ret["model"] = chat_completion.model
        ret["service_tier"] = chat_completion.service_tier

        if chat_completion.usage:
            ret["usage"] = json.loads(chat_completion.usage.json())
        else:
            ret["usage"] = None

        ret["choices"] = list()
        for choice in chat_completion.choices:
            ret["choices"].append(json.loads(choice.json()))

        return json.dumps(ret)

    def _chat_completion_chunk_to_str(self, chat_completion_chunk: ChatCompletionChunk) -> str:
        ret = dict()
        ret["id"] = chat_completion_chunk.id
        ret["object"] = chat_completion_chunk.object
        ret["created"] = chat_completion_chunk.created
        ret["model"] = chat_completion_chunk.model
        ret["service_tier"] = chat_completion_chunk.service_tier
        if chat_completion_chunk.usage:
            ret["usage"] = json.loads(chat_completion_chunk.usage.json())
        else:
            ret["usage"] = None
        ret["choices"] = list()
        for choice in chat_completion_chunk.choices:
            ret["choices"].append(json.loads(choice.json()))

        return json.dumps(ret)

    def chat_completions(self, messages: list, output_stream: IO = None) -> Union[str, None]:
        """
        :param messages:
        :param output_stream:
        :return:
        """
        if not messages:
            raise AICCException("ARK completions, messages is NULL")

        try:
            thinking = {
                "type": self.thinking_type
            }

            include_usage = True if self.kwargs.get("include_usage", "True").lower() == "true" and output_stream \
                else False

            if self.is_openai:
                openai_messages = copy.deepcopy(messages)

                client = OpenAI(base_url=self.base_url, api_key=self.api_key)
                ark_client = Ark(base_url=self.base_url, api_key=self.api_key)

                ark_certificate = ark_client._get_endpoint_certificate(self.ep)
                if isinstance(ark_certificate, tuple):
                    cipher_client = ark_certificate[0]
                    ring_id = ark_certificate[1]
                    key_id = ark_certificate[2]
                    key, nonce, token = cipher_client.generate_ecies_key_pair()
                elif isinstance(ark_certificate, key_agreement_client):
                    ring_id, key_id = ark_certificate.get_cert_ring_key_id()
                    key, nonce, token = ark_certificate.generate_ecies_key_pair()
                else:
                    logger.error(f"get ark_certificate ERROR")
                    raise AICCException("get ark_certificate ERROR")

                info = {
                    'Version': 'AICCv0.1',
                    'RingID': ring_id,
                    'KeyID': key_id,
                }

                if self.is_secure:
                    extra_headers = {
                        "X-Session-Token": token,
                        "x-ark-moderation-scene": "aicc-skip",
                        "X-Encrypt-Info": json.dumps(info),
                    }
                    for i in range(len(openai_messages)):
                        content = openai_messages[i].get("content")

                        if isinstance(content, str):
                            openai_messages[i]["content"] = aes_gcm_encrypt_base64_string(key, nonce, content)
                        elif isinstance(content, list):
                            encrypted_content = []
                            for item in content:
                                if isinstance(item, dict) and "type" in item and item["type"] == "text":
                                    # 加密文本
                                    encrypted_item = item.copy()
                                    encrypted_item["text"] = aes_gcm_encrypt_base64_string(key, nonce, item["text"])
                                    encrypted_content.append(encrypted_item)
                                elif isinstance(item, dict) and "type" in item and item["type"] == "image_url":
                                    # 加密图片
                                    encrypted_item = item.copy()
                                    encrypted_item["image_url"]["url"] = aes_gcm_encrypt_base64_string(
                                        key, nonce, item["image_url"]["url"])
                                    encrypted_content.append(encrypted_item)
                                elif isinstance(item, dict) and "type" in item and item["type"] == "video_url":
                                    # 加密视频
                                    error_info = f"Sorry, 密文豆包不支持openai格式"
                                    logger.error(error_info)
                                    raise AICCException(error_info)

                                    # encrypted_item = item.copy()
                                    # if isinstance(encrypted_item["video_url"], dict):
                                    #     encrypted_item["video_url"]["url"] = aes_gcm_encrypt_base64_string(
                                    #         key, nonce, item["video_url"]["url"])
                                    # else:
                                    #     encrypted_item["video_url"] = aes_gcm_encrypt_base64_string(
                                    #         key, nonce, item["video_url"])
                                    # encrypted_content.append(encrypted_item)
                                else:
                                    encrypted_content.append(item)
                            openai_messages[i]["content"] = encrypted_content
                        else:
                            raise AICCException("no support this content type")
                else:
                    extra_headers = {
                    }

                completion = client.chat.completions.create(
                    model=self.ep,
                    messages=openai_messages,
                    stream_options={
                        "include_usage": include_usage
                    },
                    extra_headers=extra_headers,
                    stream=True if output_stream else False,
                )
                if output_stream:
                    for chunk in completion:
                        if self.is_secure and chunk.choices and chunk.choices[0].delta.content:
                            chunk.choices[0].delta.content = aes_gcm_decrypt_base64_string(
                                key, nonce, chunk.choices[0].delta.content)
                        output_stream.write(f"{self._chat_completion_chunk_to_str(chunk)}\n")
                else:
                    if self.is_secure and completion.choices and completion.choices[0].message.content:
                        completion.choices[0].message.content = \
                            aes_gcm_decrypt_base64_string(key, nonce, completion.choices[0].message.content)
                    cont = self._chat_completion_to_str(completion)
                    return cont
            else:
                resp = self.client.chat.completions.create(
                    model=self.ep,
                    messages=messages,
                    thinking=thinking,
                    stream=True if output_stream else False,
                    stream_options={
                        "include_usage": include_usage
                    },
                    extra_headers={"x-is-encrypted": str(self.is_secure).lower(), "x-ark-moderation-scene": "aicc-skip"}
                )

                if output_stream:
                    for chunk in resp:
                        output_stream.write(f"{self._chat_completion_chunk_to_str(chunk)}\n")
                else:
                    return self._chat_completion_to_str(resp)
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"ARK completions ERROR, e={e}")
            raise AICCException("ARK completions ERROR")

    def chat_completions_stream(self, messages: list, output_stream: IO) -> Union[str, None]:
        return self.chat_completions(messages, output_stream)

    def chat_completions_stream_yield(self, messages: list):
        """
        :param messages:
        :return:
        """
        if not messages:
            raise AICCException("ARK completions, messages is NULL")

        try:
            thinking = {
                "type": self.thinking_type
            }

            include_usage = True if self.kwargs.get("include_usage", "True").lower() == "true" else False

            if self.is_openai:
                openai_messages = copy.deepcopy(messages)

                client = OpenAI(base_url=self.base_url, api_key=self.api_key)
                ark_client = Ark(base_url=self.base_url, api_key=self.api_key)
                res_a = ark_client._get_endpoint_certificate(self.ep)
                cipher_client = res_a[0]
                ring_id = res_a[1]
                key_id = res_a[2]
                key, nonce, token = cipher_client.generate_ecies_key_pair()
                info = {
                    'Version': 'AICCv0.1',
                    'RingID': ring_id,
                    'KeyID': key_id,
                }

                if self.is_secure:
                    extra_headers = {
                        "X-Session-Token": token,
                        "x-ark-moderation-scene": "aicc-skip",
                        "X-Encrypt-Info": json.dumps(info),
                    }
                    for i in range(len(openai_messages)):
                        openai_messages[i]["content"] = aes_gcm_encrypt_base64_string(
                            key, nonce, openai_messages[i].get("content"))
                else:
                    extra_headers = {
                    }

                completion = client.chat.completions.create(
                    model=self.ep,
                    messages=openai_messages,
                    stream_options={
                        "include_usage": include_usage
                    },
                    extra_headers=extra_headers,
                    stream=True,
                )

                for chunk in completion:
                    if self.is_secure and chunk.choices and chunk.choices[0].delta.content:
                        chunk.choices[0].delta.content = aes_gcm_decrypt_base64_string(
                            key, nonce, chunk.choices[0].delta.content)
                    yield self._chat_completion_chunk_to_str(chunk)
            else:
                resp = self.client.chat.completions.create(
                    model=self.ep,
                    messages=messages,
                    thinking=thinking,
                    stream=True,
                    stream_options={
                        "include_usage": include_usage
                    },
                    extra_headers={"x-is-encrypted": str(self.is_secure).lower(), "x-ark-moderation-scene": "aicc-skip"}
                )

                for chunk in resp:
                    yield self._chat_completion_chunk_to_str(chunk)
        except Exception as e:
            logger.error(f"ARK completions ERROR, e={e}")
            raise AICCException("ARK completions ERROR")

    def function_call(self, messages: list, tools: list, output_stream: IO = None) -> str:
        """
        :param messages:
        :param tools:
        :param output_stream:
        :return:
        """
        if not messages or not tools:
            raise AICCException("doubao function_call params cannot be empty")

        try:
            resp = self.client.chat.completions.create(
                model=self.ep,
                messages=messages,
                tools=tools,
            )
            return self._chat_completion_to_str(resp)
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"call AICC ARK service function_call error: {e}")
            raise AICCException("AICC ARK service function_call error")

    def function_call_stream(self, messages: list, tools: list, output_stream: IO) -> str:
        return self.function_call(messages, tools, output_stream)

    def asr_recognize(self, file_name: str) -> str:
        error_info = "Sorry, this version does not support asr at this time."
        logger.error(error_info)
        return error_info
