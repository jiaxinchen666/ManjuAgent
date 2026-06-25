from typing import Optional

__all__ = [
    "TKSError",
    "RAError",
]


class TKSError(Exception):
    def __init__(self, message: str, http_status: Optional[int] = None):
        super().__init__(message)
        self.http_status = http_status

    def __str__(self):
        if self.http_status:
            return f"{self.args[0]} (HTTP Status: {self.http_status})"
        return self.args[0]


class RAError(TKSError):
    def __init__(self, message: str, http_status: Optional[int] = None):
        super().__init__(message, http_status)
