__all__ = [
    "AICCClient",
    "AICCModelType",
    "__version__",
]

__version__ = "0.0.21"

from .aicc_client import AICCModelType
from .aicc_client import AICCClient


def __getattr__(name: str) -> object:
    raise AttributeError(f"module {__name__} has no attribute {name}")
