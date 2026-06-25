"""
移动云 Seedance SDK
用于访问移动云视频生成服务的Python客户端
"""
import sys
from pathlib import Path

# 添加_vendor目录到Python路径，以便导入bytedance依赖
_vendor_dir = Path(__file__).parent / "_vendor"
if _vendor_dir.exists():
    # 直接将vendor目录添加到sys.path
    sys.path.insert(0, str(_vendor_dir))

from .client import MaasSeedanceClient

__version__ = "1.0.0"
__all__ = ["MaasSeedanceClient"]
