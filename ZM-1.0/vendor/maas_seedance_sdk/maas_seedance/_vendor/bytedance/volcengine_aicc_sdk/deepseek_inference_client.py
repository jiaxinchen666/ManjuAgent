"""
DeepSeek机密推理客户端
"""
__all__ = ["DeepSeekClient"]

import base64
import copy
import json
import time
import requests
import pickle
import bytedance.jeddak_secure_channel as jsc
from typing import IO, Union

from openai.types.chat import ChatCompletionMessage, ChatCompletionChunk

from .aicc_inference import AICCInference
from .common.constant import Constants
from .common.error import AICCException
from .common.log import logger
from openai import OpenAI


class DeepSeekClient(AICCInference):
    """
    DeepSeek机密推理客户端.
    """

    def __init__(self,
                 base_url: str = None,
                 api_key: str = None,
                 ep: str = None,
                 aicc_service_name: str = None,
                 policy_id: str = None,
                 is_openai: bool = True,
                 is_secure: bool = True,
                 ak: str = None,
                 sk: str = None,
                 region: str = "cn-beijing",
                 **kwargs):
        if not base_url or not api_key or not aicc_service_name or not policy_id or not ak or not sk:
            raise AICCException("New deepseek client failed, params error")

        super().__init__(base_url, is_openai, is_secure, ak, sk, region)

        self.api_key = api_key
        self.ep = ep
        self.aicc_service_name = aicc_service_name
        self.policy_id = policy_id

        self.kwargs = kwargs

        self.dp_version = self.kwargs.get("dp_version", "3.1")
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

    def _encrypt_prompt_with_jsc(self, messages: list) -> object:
        """
        使用端云互信SDK对prompt进行加密
        :param messages:
        :return: 返回对称解密密钥（多密钥时返回 role user 的content加密 密钥）
        """
        if not messages or not self.jsc_client:
            logger.error(f"messages is NULL")
            return None

        ret_encrypt_key = None
        for i in range(len(messages)):
            messages[i]["content"], encrypt_key = self.jsc_client.encrypt_with_response(
                json.dumps(messages[i].get("content")))
            if messages[i].get("role") == "user":
                ret_encrypt_key = encrypt_key

        return ret_encrypt_key

    def _chat_completion_message_to_str(self, chat_message: ChatCompletionMessage) -> str:
        ret = dict()
        ret["role"] = chat_message.role
        ret["content"] = chat_message.content
        ret["reasoning_content"] = chat_message.reasoning_content
        ret["tool_calls"] = chat_message.tool_calls
        ret["refusal"] = chat_message.refusal
        ret["annotations"] = chat_message.annotations
        ret["audio"] = chat_message.audio
        ret["function_call"] = chat_message.function_call
        return json.dumps(ret)

    def _chat_completion_chunk_to_str(self, chat_completion_chunk: ChatCompletionChunk) -> str:
        ret = dict()
        ret["id"] = chat_completion_chunk.id
        ret["object"] = chat_completion_chunk.object
        ret["created"] = chat_completion_chunk.created
        ret["model"] = chat_completion_chunk.model

        if chat_completion_chunk.usage:
            ret["usage"] = dict()
            ret["usage"]["completion_tokens"] = chat_completion_chunk.usage.completion_tokens
            ret["usage"]["prompt_tokens"] = chat_completion_chunk.usage.prompt_tokens
            ret["usage"]["total_tokens"] = chat_completion_chunk.usage.total_tokens
            ret["usage"]["completion_tokens_details"] = chat_completion_chunk.usage.completion_tokens_details
            ret["usage"]["prompt_tokens_details"] = chat_completion_chunk.usage.prompt_tokens_details
            ret["usage"]["reasoning_tokens"] = chat_completion_chunk.usage.reasoning_tokens
        else:
            ret["usage"] = None

        ret["choices"] = list()

        for choice in chat_completion_chunk.choices:
            choice_info = dict()
            choice_info["index"] = choice.index
            choice_info["logprobs"] = choice.logprobs
            choice_info["finish_reason"] = choice.finish_reason
            choice_info["matched_stop"] = choice.matched_stop
            choice_info["delta"] = dict()
            choice_info["delta"]["content"] = choice.delta.content
            choice_info["delta"]["function_call"] = choice.delta.function_call
            choice_info["delta"]["refusal"] = choice.delta.refusal
            choice_info["delta"]["role"] = choice.delta.role
            choice_info["delta"]["tool_calls"] = choice.delta.tool_calls
            choice_info["delta"]["reasoning_content"] = choice.delta.reasoning_content

            ret["choices"].append(choice_info)

        return json.dumps(ret)

    def chat_completions(self, messages: list, output_stream: IO = None) -> Union[str, None]:
        """
        生成聊天补全
        :param messages:
        :param output_stream:
        :return:
        """
        try:
            if not messages:
                raise AICCException("DeepSeek chat_completions Messages cannot be empty")

            # DeepSeek目前仅3.1支持openai的方式
            if self.dp_version < "3.1" and self.is_openai:
                error_info = f"Sorry, DeepSeek{self.dp_version} not support is_openai={self.is_openai}"
                logger.error(error_info)
                raise AICCException(error_info)

            if self.is_secure:
                # V3.1用V4， V3.0用V2
                if self.dp_version < "3.1":
                    url = f"{self.base_url}/v2/chat/completions"
                else:
                    url = f"{self.base_url}/v4/chat/completions"
            else:
                url = f"{self.base_url}/v1/chat/completions"

            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}
            payload = {
                "messages": messages,
                "max_tokens": int(self.kwargs.get("max_tokens", 100)),
                "temperature": float(self.kwargs.get("temperature", 1.0)),
                "chat_template_kwargs": {"thinking": self.kwargs.get("thinking", True)},
                "separate_reasoning": True
            }
            if output_stream:
                payload["stream"] = True
                payload["stop"] = "<|im_end|>"
                payload["eos_token"] = "<|im_end|>"

            if self.is_openai:
                openai_messages = copy.deepcopy(messages)
                encrypt_key = None
                if self.is_secure:
                    encrypt_key = self._encrypt_prompt_with_jsc(openai_messages)
                    if not encrypt_key:
                        raise AICCException("Error during openai encrypt")

                url = url.rstrip("/chat/completions")
                openai_client = OpenAI(base_url=url, api_key=self.api_key)

                resp = openai_client.chat.completions.create(
                    model=self.ep if self.ep else "",
                    messages=openai_messages,
                    temperature=payload.get("temperature"),
                    max_tokens=payload.get("max_tokens"),
                    stream=True if output_stream else False,
                )

                if output_stream:
                    for chunk in resp:
                        if self.is_secure and encrypt_key:
                            if chunk.content:
                                data = encrypt_key.decrypt(base64.b64decode(chunk.content)).decode("utf-8")
                                if data.startswith("data:"):
                                    data = data.strip("data:").strip()
                                output_stream.write(f"{data}\n")
                        else:
                            cont = self._chat_completion_chunk_to_str(chunk)
                            output_stream.write(f"{cont}\n")
                    return
                else:
                    resp_msg = resp.choices[0].message
                    if self.is_secure and encrypt_key:
                        resp_msg = encrypt_key.decrypt(resp_msg).decode("utf-8")
                        return resp_msg
                    else:
                        return self._chat_completion_message_to_str(resp_msg)

            encrypt_key = None
            if self.is_secure:
                # 加密数据并发送
                try:
                    if self.dp_version < "3.1":
                        encrypted_messages, encrypt_key = \
                            self.jsc_client.encrypt_with_response(pickle.dumps(payload["messages"]))
                    else:
                        encrypted_messages, encrypt_key = \
                            self.jsc_client.encrypt_with_response(json.dumps(payload["messages"]))

                    payload["messages"] = encrypted_messages  # 敏感字段
                except Exception as e:
                    logger.error(f"Error during encrypt: {e}")
                    raise AICCException("Error during encrypt")

            if output_stream:
                try:
                    with requests.post(url, json=payload, headers=headers, stream=True) as response:
                        response.raise_for_status()
                        for chunk in response.iter_lines():
                            if chunk:
                                if self.is_secure and encrypt_key:
                                    if self.dp_version < "3.1":
                                        data = encrypt_key.decrypt(base64.b64decode(chunk)).decode("utf-8")
                                        output_stream.write(f"{data}\n")
                                    else:
                                        chunk_str = chunk.decode("utf-8")
                                        if chunk_str.startswith("data:"):
                                            chunk_str = chunk_str.strip("data:").strip()
                                        if chunk_str == "[DONE]":
                                            output_stream.write(chunk_str + "\n")
                                        else:
                                            content = json.loads(chunk_str).get("content")
                                            data = encrypt_key.decrypt(base64.b64decode(content)).decode("utf-8")
                                            output_stream.write(f"{data}\n")
                                else:
                                    chunk_str = chunk.decode("utf-8")
                                    if chunk_str.startswith("data:"):
                                        chunk_str = chunk_str.strip("data:").strip()
                                    output_stream.write(f"{chunk_str}\n")
                except Exception as e:
                    logger.error(f"call AICC DeepSeek service chat_completions error:{e}")
                    raise AICCException("DeepSeek chat_completions_stream error")
            else:
                for attempt in range(self.max_retries):
                    try:
                        response = requests.post(url, json=payload, headers=headers)
                        response.raise_for_status()
                        data = response.json()

                        if self.is_secure and encrypt_key:
                            for elm in data['choices']:
                                if self.dp_version < "3.1":
                                    elm['message'] = pickle.loads(encrypt_key.decrypt(elm['message']))
                                else:
                                    elm['message'] = json.loads(encrypt_key.decrypt(elm['message']))

                        return json.dumps(data)
                    except Exception as e:
                        if attempt == self.max_retries - 1:
                            logger.error(f"call AICC DeepSeek service chat_completions error:{e}")
                            raise AICCException("DeepSeek chat_completions error")
                        else:
                            logger.error(f"call AICC DeepSeek service chat_completions error:{e}, try again....")
                            time.sleep(1)
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"call AICC deepseek service chat_completions error: {e}")
            raise AICCException("AICC deepseek service chat_completions error")

    def chat_completions_stream(self, messages: list, output_stream: IO) -> Union[str, None]:
        return self.chat_completions(messages, output_stream)

    def chat_completions_stream_yield(self, messages: list):
        """
        生成聊天补全
        :param messages:
        :return:
        """
        try:
            if not messages:
                raise AICCException("DeepSeek chat_completions Messages cannot be empty")

            # DeepSeek目前仅3.1支持openai的方式
            if self.dp_version < "3.1" and self.is_openai:
                error_info = f"Sorry, DeepSeek{self.dp_version} not support is_openai={self.is_openai}"
                logger.error(error_info)
                raise AICCException(error_info)

            if self.is_secure:
                # V3.1用V4， V3.0用V2
                if self.dp_version < "3.1":
                    url = f"{self.base_url}/v2/chat/completions"
                else:
                    url = f"{self.base_url}/v4/chat/completions"
            else:
                url = f"{self.base_url}/v1/chat/completions"

            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}
            payload = {
                "messages": messages,
                "max_tokens": int(self.kwargs.get("max_tokens", 100)),
                "temperature": float(self.kwargs.get("temperature", 1.0)),
                "chat_template_kwargs": {"thinking": self.kwargs.get("thinking", True)},
                "separate_reasoning": True,
                "stream": True,
                "stop": "<|im_end|>",
                "eos_token": "<|im_end|>"
            }

            if self.is_openai:
                openai_messages = copy.deepcopy(messages)
                encrypt_key = None
                if self.is_secure:
                    encrypt_key = self._encrypt_prompt_with_jsc(openai_messages)
                    if not encrypt_key:
                        raise AICCException("Error during openai encrypt")

                url = url.rstrip("/chat/completions")
                openai_client = OpenAI(base_url=url, api_key=self.api_key)

                resp = openai_client.chat.completions.create(
                    model=self.ep if self.ep else "",
                    messages=openai_messages,
                    temperature=payload.get("temperature"),
                    max_tokens=payload.get("max_tokens"),
                    stream=True,
                )

                for chunk in resp:
                    if self.is_secure and encrypt_key:
                        if chunk.content:
                            data = encrypt_key.decrypt(base64.b64decode(chunk.content)).decode("utf-8")
                            if data.startswith("data:"):
                                data = data.strip("data:").strip()
                            yield data
                    else:
                        cont = self._chat_completion_chunk_to_str(chunk)
                        yield cont
            else:
                encrypt_key = None
                if self.is_secure:
                    # 加密数据并发送
                    try:
                        if self.dp_version < "3.1":
                            encrypted_messages, encrypt_key = \
                                self.jsc_client.encrypt_with_response(pickle.dumps(payload["messages"]))
                        else:
                            encrypted_messages, encrypt_key = \
                                self.jsc_client.encrypt_with_response(json.dumps(payload["messages"]))

                        payload["messages"] = encrypted_messages  # 敏感字段
                    except Exception as e:
                        logger.error(f"Error during encrypt: {e}")
                        raise AICCException("Error during encrypt")

                try:
                    with requests.post(url, json=payload, headers=headers, stream=True) as response:
                        response.raise_for_status()
                        for chunk in response.iter_lines():
                            if chunk:
                                if self.is_secure and encrypt_key:
                                    chunk_str = chunk.decode("utf-8")
                                    if chunk_str.startswith("data:"):
                                        chunk_str = chunk_str.strip("data:").strip()
                                    if chunk_str == "[DONE]":
                                        yield chunk_str
                                    else:
                                        if self.dp_version < "3.1":
                                            data = encrypt_key.decrypt(base64.b64decode(chunk_str)).decode("utf-8")
                                        else:
                                            content = json.loads(chunk_str).get("content")
                                            data = encrypt_key.decrypt(base64.b64decode(content)).decode("utf-8")
                                        yield data
                                else:
                                    chunk_str = chunk.decode("utf-8")
                                    if chunk_str.startswith("data:"):
                                        chunk_str = chunk_str.strip("data:").strip()
                                    yield chunk_str
                except Exception as e:
                    logger.error(f"call AICC DeepSeek service chat_completions_stream_yield error:{e}")
                    raise AICCException("DeepSeek chat_completions_stream_yield error")
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"call AICC deepseek service chat_completions_stream_yield error: {e}")
            raise AICCException("AICC deepseek service chat_completions_stream_yield error")

    def function_call(self, messages: list, tools: list, output_stream: IO = None) -> str:
        """
        :param messages:
        :param tools:
        :param output_stream:
        :return:
        """
        if not messages or not tools:
            raise AICCException("DeepSeek function_call params cannot be empty")

        try:
            # DeepSeek目前仅支持通过openai的方式使用function_call
            if not self.is_openai:
                error_info = f"Sorry, DeepSeek is_openai={self.is_openai} not support function_call."
                logger.error(error_info)
                raise AICCException(error_info)

            # DeepSeek function_call目前仅支持密文访问
            if not self.is_secure:
                error_info = f"Sorry, DeepSeek secure={self.is_secure} not support function_call."
                logger.error(error_info)
                raise AICCException(error_info)

            if self.is_secure:
                url = f"{self.base_url}/v4"
            else:
                url = f"{self.base_url}/v1"

            openai_client = OpenAI(base_url=url, api_key=self.api_key)

            openai_messages = copy.deepcopy(messages)
            encrypt_key = None
            if self.is_secure:
                encrypt_key = self._encrypt_prompt_with_jsc(openai_messages)
                if not encrypt_key:
                    raise AICCException("Error during openai encrypt")

            if self.is_secure:
                if self.dp_version < "3.1":
                    encrypted_tools, _ = self.jsc_client.encrypt_with_response(pickle.dumps(tools))
                else:
                    encrypted_tools, _ = self.jsc_client.encrypt_with_response(json.dumps(tools))
            else:
                encrypted_tools = tools

            extra_fields = {
                "aicc_enc_tools": encrypted_tools
            }

            completion = openai_client.chat.completions.create(
                model=self.ep,
                messages=openai_messages,
                tool_choice="required",
                extra_body=extra_fields,
                stream=True if output_stream else False,
            )

            if output_stream:
                for chunk in completion:
                    if not hasattr(chunk, 'content') or chunk.content is None:
                        continue
                    if chunk.content == "[DONE]":
                        output_stream.write("[DONE]\n")
                    if self.is_secure and encrypt_key:
                        decrypted_data = encrypt_key.decrypt(base64.b64decode(chunk.content)).decode("utf-8")
                        if decrypted_data.startswith("data:"):
                            decrypted_data = decrypted_data.strip("data:").strip()
                        output_stream.write(f"{decrypted_data}\n")
                    else:
                        output_stream.write(f"{chunk.content}\n")
            else:
                resp_msg = completion.choices[0].message
                if self.is_secure and encrypt_key:
                    resp_msg = encrypt_key.decrypt(resp_msg).decode("utf-8")

                return resp_msg
        except AICCException as e:
            raise e
        except Exception as e:
            logger.error(f"call AICC deepseek service chat_completions error: {e}")
            raise AICCException("AICC deepseek service chat_completions error")

    def function_call_stream(self, messages: list, tools: list, output_stream: IO) -> str:
        return self.function_call(messages, tools, output_stream)

    def asr_recognize(self, file_name: str) -> str:
        error_info = "Sorry, this version does not support asr at this time."
        logger.error(error_info)
        return error_info
