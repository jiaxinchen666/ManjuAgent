"""
AICC机密推理客户端BASE
"""
__all__ = ["AICCInference"]

from abc import ABC, abstractmethod
from typing import IO, Union


class AICCInference(ABC):
    """
    AICC机密推理访问客户端.
    """

    def __init__(self,
                 base_url: str = None,
                 is_openai: bool = True,
                 is_secure: bool = True,
                 ak: str = None,
                 sk: str = None,
                 region: str = "cn-beijing"
                 ):
        self.base_url = base_url
        self.is_openai = is_openai
        self.is_secure = is_secure
        self.ak = ak
        self.sk = sk
        self.region = region

    @staticmethod
    def hello() -> str:
        info = "hello aicc inference"
        print(info)
        return info

    @abstractmethod
    def chat_completions(self, messages: list, output_stream: IO = None) -> Union[str, None]:
        """
        生成聊天补全
        :param messages:
        :param output_stream:是否启用流式响应
        :return:
        """
        pass

    @abstractmethod
    def function_call(self, messages: list, tools: list, output_stream: IO = None) -> Union[str, None]:
        """
        生成聊天补全
        :param messages:
        :param tools:
        :param output_stream: 是否开启流式
        :return:
        """
        pass

    @abstractmethod
    def asr_recognize(self, file_name: str) -> Union[str, None]:
        """
        ASR转文字
        :param file_name:
        :return:
        """
        pass
