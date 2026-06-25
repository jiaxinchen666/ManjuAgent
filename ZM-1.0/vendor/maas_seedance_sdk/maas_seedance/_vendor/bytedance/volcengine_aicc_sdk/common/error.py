"""
安全通信错误类型.
"""

__all__ = [
    "AICCException"
]


class AICCException(Exception):
    """AICC 异常"""

    def __init__(self, msg):
        Exception.__init__(self)
        self._msg = msg

    def get_msg(self):
        return self._msg

    def __str__(self):
        return self.get_msg()
