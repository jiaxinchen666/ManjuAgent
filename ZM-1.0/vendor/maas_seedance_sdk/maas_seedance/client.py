import json
import logging
from typing import Any, Dict, List, Optional
from pathlib import Path
import requests
from bytedance.volcengine_aicc_sdk.aicc_client import AICCClient

logger = logging.getLogger("MaasSeedanceClient")


class MaasSeedanceClient:
    """
    移动云 Seedance 客户端
    """

    MAPPING_QUERY_PATH = "/mapping/query"

    def __init__(
        self,
        maas_base_url: str,
        maas_api_key: str,
        maas_model: str,
        enable_video_encrypt: bool = True
    ) -> None:
        """
        Args:
            maas_base_url:       移动云网关地址
            maas_api_key:        移动云 API Key
            maas_model:          移动云模型名
            enable_video_encrypt: true=视频加密存储; false=明文存储
        """

        self.maas_model: str = self._resolve_actual_model(
            maas_base_url, maas_api_key, maas_model)
        self.original_model = maas_model
        self.enable_video_encrypt = enable_video_encrypt
        self.volc_client = AICCClient(
            base_url=maas_base_url,                     # 请求发到移动云网关
            api_key=maas_api_key,                       # 移动云 apiKey，网关 ApiKeyAuthFilter 会替换
            endpoint=self.maas_model,                      # 移动云模型名，网关 HuoShanRouteFilter 会替换
            is_enable_video_encrypt=enable_video_encrypt,  # 是否启用视频文件加密
        ).get_llm_instance("seedance")

        logger.info(
            "[MaasSeedanceClient] 初始化成功, baseUrl: %s, originalModel: %s, "
            "actualModel: %s, enableVideoEncrypt: %s",
            maas_base_url, maas_model, self.maas_model, enable_video_encrypt,
        )

    # ==================== 模型映射解析 ====================
    def _resolve_actual_model(self, base_url: str, api_key: str, model: str) -> str:
        """
        解析实际使用的模型名
       
        """
        try:
            # 确保 baseUrl 不以 / 结尾
            clean_base_url = base_url.rstrip("/")
            mapping_url = clean_base_url + self.MAPPING_QUERY_PATH
            logger.info(
                "[MaasSeedanceClient] Querying model mapping: url=%s, model=%s", mapping_url, model)

            # 构造请求体
            request_body = {"model": model}
            logger.debug(
                "[MaasSeedanceClient] Mapping query request body: %s", json.dumps(request_body))

            response = requests.post(
                mapping_url,
                json=request_body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                timeout=(5, 10),
            )

            logger.info(
                "[MaasSeedanceClient] Mapping query response: status=%d, body=%s",
                response.status_code, response.text,
            )

            if response.status_code == 200:
                data = response.json()
                endpoint = data.get("endpoint", "")
                if endpoint:
                    logger.info(
                        "[MaasSeedanceClient] Resolved model mapping: %s -> %s", model, endpoint)
                    return endpoint
                else:
                    logger.warning(
                        "[MaasSeedanceClient] No endpoint found in mapping response "
                        "for model: %s, using original model", model,
                    )
            else:
                logger.warning(
                    "[MaasSeedanceClient] Mapping query failed with status: %d, "
                    "using original model: %s", response.status_code, model,
                )

        except Exception as e:
            logger.warning(
                "[MaasSeedanceClient] Failed to query model mapping, "
                "using original model: %s. Error: %s", model, str(e), exc_info=True,
            )

        return model

    # ==================== 视频加密密钥管理 ====================
    def set_video_file_encrypt_key(self, public_key_path: str, private_key_path: str) -> None:
        """
        设置视频文件加密密钥对
        用于视频文件的 RSA 加密/解密，这是客户端侧的功能，不影响请求链路
        """
        if not self.enable_video_encrypt:
            logger.warning("[MaasSeedanceClient] 当前为明文模式，无需设置视频加密密钥，调用将被忽略")
            return

        pub_key_file = Path(public_key_path)
        priv_key_file = Path(private_key_path)

        if not pub_key_file.exists() or not priv_key_file.exists():
            logger.info("[MaasSeedanceClient] Generating RSA key pair...")
            self.volc_client.generate_video_file_encrypt_key(
                public_key_path, private_key_path)
            logger.info(
                "[MaasSeedanceClient] RSA key pair generated successfully")
        else:
            logger.info(
                "[MaasSeedanceClient] Loading existing RSA key pair from: %s", public_key_path)

        self.volc_client.set_video_file_encrypt_key(
            public_key_path, private_key_path)

    # ==================== 创建任务 ====================
    def create_video_generation_task(self, data: Dict[str, Any]) -> str:
        """
        创建视频生成任务
        自动判断请求体中是否包含视频输入，通过自定义请求头传递 input_has_video
        Args:
            data: 请求体字典

        Returns:
            taskId: 创建的任务 ID
        """
        # 确保 model 字段使用移动云模型名（网关会替换为火山endpoint）
        data["model"] = self.maas_model

        # 调试日志
        logger.info("[MaasSeedanceClient] Request body after adding model: %s", json.dumps(
            data, ensure_ascii=False))
        logger.info("[MaasSeedanceClient] Model value: %s", data.get("model"))

        headers: Dict[str, str] = {}
        if self._has_video_input(data):
            headers["Input-Has-Video"] = "true"

        logger.info(
            "[MaasSeedanceClient] Creating video generation task, Input-Has-Video: %s",
            headers.get("Input-Has-Video", "false"),
        )

        task_id: str = self.volc_client.create_video_generation_task(
            data, headers)
        logger.info(
            "[MaasSeedanceClient] Task created successfully, taskId: %s", task_id)
        return task_id

    # ==================== 查询任务 ====================

    def query_video_generation_task(self, task_id: str) -> Dict[str, Any]:
        """
        查询任务状态

        """
        logger.info(
            "[MaasSeedanceClient] Querying video generation task: %s", task_id)

        result: Dict[str, Any] = self.volc_client.query_video_generation_task(
            task_id)
        if result is not None:
            status = result.get("status")
            logger.info("[MaasSeedanceClient] Task status: %s", status)
        return result

    def query_video_generation_task_list(
        self,
        page_num: Optional[int] = None,
        page_size: Optional[int] = None,
        status: Optional[str] = None,
        task_ids: Optional[List[str]] = None,
        model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        查询任务列表（分页 + 多条件过滤）
        """
        logger.info(
            "[MaasSeedanceClient] Querying video generation task list - "
            "page_num: %s, page_size: %s, status: %s, task_ids: %s, model: %s",
            page_num, page_size, status, task_ids, model
        )

        return self.volc_client.query_video_generation_task_list(
            page_num, page_size, status, task_ids, model
        )

    # ==================== 视频下载 ====================
    def download_video(self, task_id: str, local_file_path: str) -> bool:
        """
        下载视频文件
        """
        logger.info(
            "[MaasSeedanceClient] Downloading video: taskId=%s, localPath=%s", task_id, local_file_path)

        success: bool = self.volc_client.video_file_download(
            task_id, local_file_path)
        if success:
            logger.info(
                "[MaasSeedanceClient] Video downloaded successfully to: %s", local_file_path)
        else:
            logger.warning(
                "[MaasSeedanceClient] Video download failed for taskId: %s", task_id)
        return success

    # ==================== 删除任务 ====================

    def delete_video_generation_task(self, task_id: str) -> bool:
        """
        删除任务

        """
        logger.info(
            "[MaasSeedanceClient] Deleting video generation task: %s", task_id)

        result = self.volc_client.delete_video_generation_task(task_id)
        return result is not None

    # ==================== 内部工具方法 ====================
    def _has_video_input(self, data: Dict[str, Any]) -> bool:
        """
        判断请求体中是否包含视频输入
        检查 content 列表中是否存在 type == "video_url" 的项

        """
        content = data.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "video_url":
                    return True
        return False
