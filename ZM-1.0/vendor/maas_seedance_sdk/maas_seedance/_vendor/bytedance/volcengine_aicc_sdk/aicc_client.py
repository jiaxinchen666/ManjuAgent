from bytedance.volcengine_aicc_sdk.seedance_inference_client import SeedanceClient
"""
AICC访问客户端
"""

__all__ = [
    "AICCClient",
    "AICCModelType"
]

from bytedance.volcengine_aicc_sdk.cu_inference_client import CUClient
from bytedance.volcengine_aicc_sdk.ark_inference_client import ARKClient
from bytedance.volcengine_aicc_sdk.deepseek_inference_client import DeepSeekClient
from .asr_inference_client import ASRClient
from volcenginesdkarkruntime import Ark
from .common.error import AICCException
from .common.log import LogConfig, logger
from bytedance.volcengine_aicc_sdk.secure_http_client import AICCConfig


class AICCModelType:
    DOUBAO = "DOUBAO"  # 机密豆包
    AICC_CU = "AICC-CU"   # AICC CU版模型
    OSLM = "OSLM"  # 开源模型
    ASR = "ASR"
    SEEDANCE = "SEEDANCE"


class AICCClient:
    """
    AICC机密推理访问客户端.
    """

    def __init__(self,
                 base_url: str = "",
                 api_key: str = "",
                 endpoint: str = "",
                 aicc_config: AICCConfig = None,
                 **kwargs
                 ):
        self.base_url = base_url
        self.api_key = api_key
        self.aicc_config = aicc_config
        self.endpoint = endpoint
        self.kwargs = kwargs

        if not self.base_url or not self.api_key:
            raise AICCException(f"New AICC client failed, base_url={self.base_url}, api_key={self.api_key}")

        if not self.endpoint:
            self.endpoint = self.kwargs.get("model_name")

        self.config = dict()
        self._init_config()
        self._init_log()

    def get_llm_instance(self, model_type):
        model_type = model_type.upper()
        if AICCModelType.SEEDANCE in model_type:
            return SeedanceClient(base_url=self.base_url,
                                  api_key=self.api_key,
                                  endpoint=self.endpoint,
                                  aicc_config=self.aicc_config,
                                  **self.kwargs)
        elif AICCModelType.AICC_CU in model_type:
            return CUClient(base_url=self.base_url,
                            aicc_service_name=self.aicc_config.aicc_llm_service_name,
                            policy_id=self.aicc_config.policy_id,
                            is_openai=self.kwargs.get("is_openai"),
                            is_secure=self.kwargs.get("is_secure"),
                            ak=self.aicc_config.ak,
                            sk=self.aicc_config.sk,
                            region=self.aicc_config.region,
                            **self.kwargs)
        elif AICCModelType.ASR in model_type:
            return ASRClient(base_url=self.base_url,
                             aicc_service_name=self.aicc_config.aicc_llm_service_name,
                             policy_id=self.aicc_config.policy_id,
                             is_openai=self.kwargs.get("is_openai"),
                             is_secure=self.kwargs.get("is_secure"),
                             ak=self.aicc_config.ak,
                             sk=self.aicc_config.sk,
                             region=self.aicc_config.region,
                             **self.kwargs)
        elif AICCModelType.OSLM in model_type:
            return DeepSeekClient(base_url=self.base_url,
                                  api_key=self.api_key,
                                  ep=self.endpoint,
                                  aicc_service_name=self.aicc_config.aicc_llm_service_name,
                                  policy_id=self.aicc_config.policy_id,
                                  is_openai=self.kwargs.get("is_openai"),
                                  is_secure=self.kwargs.get("is_secure"),
                                  ak=self.aicc_config.ak,
                                  sk=self.aicc_config.sk,
                                  region=self.aicc_config.region,
                                  **self.kwargs)
        elif AICCModelType.DOUBAO in model_type:
            return ARKClient(base_url=self.base_url,
                             api_key=self.api_key,
                             ep=self.endpoint,
                             is_openai=self.kwargs.get("is_openai"),
                             is_secure=self.kwargs.get("is_secure"),
                             ak=self.aicc_config.ak,
                             sk=self.aicc_config.sk,
                             region=self.aicc_config.region,
                             **self.kwargs)
        else:
            raise AICCException(f"New AICC client failed, model_type={model_type}")

    @staticmethod
    def get_inference_instance(model_type: str,
                               base_url: str = None,
                               api_key: str = None,
                               ep: str = None,
                               aicc_service_name: str = None,
                               policy_id: str = None,
                               is_openai: bool = False,
                               is_secure: bool = True,
                               ak: str = None,
                               sk: str = None,
                               region: str = "cn-beijing",
                               **kwargs):
        if model_type.upper() == AICCModelType.DOUBAO:
            return ARKClient(base_url=base_url,
                             api_key=api_key,
                             ep=ep,
                             is_openai=is_openai,
                             is_secure=is_secure,
                             ak=ak,
                             sk=sk,
                             region=region,
                             **kwargs)
        elif model_type.upper() == AICCModelType.AICC_CU:
            return CUClient(base_url=base_url,
                            aicc_service_name=aicc_service_name,
                            policy_id=policy_id,
                            is_openai=is_openai,
                            is_secure=is_secure,
                            ak=ak,
                            sk=sk,
                            region=region,
                            **kwargs)
        elif model_type.upper() == AICCModelType.OSLM:
            return DeepSeekClient(base_url=base_url,
                                  api_key=api_key,
                                  ep=ep,
                                  aicc_service_name=aicc_service_name,
                                  policy_id=policy_id,
                                  is_openai=is_openai,
                                  is_secure=is_secure,
                                  ak=ak,
                                  sk=sk,
                                  region=region,
                                  **kwargs)
        elif model_type.upper() == AICCModelType.ASR:
            return ASRClient(base_url=base_url,
                             aicc_service_name=aicc_service_name,
                             policy_id=policy_id,
                             is_openai=is_openai,
                             is_secure=is_secure,
                             ak=ak,
                             sk=sk,
                             region=region,
                             **kwargs)
        else:
            err_str = f"can not support model type:{model_type}"
            logger.error(err_str)
            raise AICCException(err_str)

    @staticmethod
    def get_volcengine_ark(base_url: str = None, api_key: str = None, **kwargs):
        return Ark(api_key=api_key, base_url=base_url, **kwargs)

    @staticmethod
    def hello() -> str:
        info = "hello volcengine_aicc_sdk"
        print(info)
        return info

    def _init_config(self):
        pass

    def _init_log(self):
        config = LogConfig()

        if log_dir := self.config.get("dir", "aicc_log"):
            config.dir = log_dir

        if filename := self.config.get("filename", "aicc.log"):
            config.filename = filename

        if rotation := self.config.get("rotation", 100):
            config.rotation = rotation

        if retention := self.config.get("retention", 30):
            config.retention = retention

        if level := self.config.get("level"):
            config.level = level

        logger.init_log_config(config)
