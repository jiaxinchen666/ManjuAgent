__all__ = [
    "format_query",
    "file_to_base64",
    "base64_to_file"
]

import base64
import json
import urllib.parse
from typing import Dict


def file_to_base64(file_path):
    with open(file_path, 'rb') as file:
        file_data = file.read()  # 读取文件内容
        base64_data = base64.b64encode(file_data).decode('utf-8')  # Base64 编码
    return base64_data


# 辅助函数：将Base64数据写入文件
def base64_to_file(base64_data, output_file_path):
    """将Base64编码的数据写入文件"""
    if not base64_data:
        print("没有Base64数据可写入文件。")
        return False
    try:
        # 将Base64字符串解码为二进制数据
        binary_data = base64.b64decode(base64_data)
        # 写入文件
        with open(output_file_path, 'wb') as f:
            f.write(binary_data)
        print(f"成功将Base64数据写入文件：{output_file_path}")
        return True
    except Exception as e:
        print(f"写入文件失败：{e}")
        return False


def format_query(params: Dict[str, str]) -> str:
    return "&".join(
        urllib.parse.quote(key, safe="-_.~")
        + "="
        + urllib.parse.quote(value, safe="-_.~")
        for key, value in params.items()
    )
