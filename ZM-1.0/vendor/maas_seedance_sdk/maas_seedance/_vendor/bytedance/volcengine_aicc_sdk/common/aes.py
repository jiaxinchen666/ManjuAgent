__all__ = [
    "gcm_encrypt",
    "gcm_decrypt",
    "aes_encrypt",
    "aes_decrypt",
    "encrypt_file",
    "decrypt_file"
]

import base64
from typing_extensions import IO, Union

import secrets

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


SALT = "ai-handler-salt"


def gcm_decrypt(key: bytes, ciphertext: bytes) -> bytes:
    iv, ciphertext = ciphertext[:12], ciphertext[12:]
    ciphertext, tag = ciphertext[:-16], ciphertext[-16:]
    decryptor = Cipher(
        algorithms.AES(key),
        modes.GCM(iv, tag),
    ).decryptor()

    return decryptor.update(ciphertext) + decryptor.finalize()


def gcm_encrypt(key: bytes, plaintext: bytes) -> bytes:
    iv = secrets.token_bytes(12)
    encryptor = Cipher(
        algorithms.AES(key),
        modes.GCM(iv),
    ).encryptor()

    ciphertext = encryptor.update(plaintext) + encryptor.finalize()
    return iv + ciphertext + encryptor.tag


def generate_key_from_string(seed_string: str) -> bytes:
    backend = default_backend()
    # 将字符串种子转换为字节
    password = seed_string.encode()
    salt = SALT.encode()
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100000, backend=backend
    )
    key = kdf.derive(password)
    return key


def aes_encrypt(aes_key: Union[bytes, str], data: Union[bytes, str]) -> bytes:
    if isinstance(aes_key, str):
        aes_key = aes_key.encode()
    if isinstance(data, str):
        data = data.encode()
    return gcm_encrypt(aes_key, data)


def aes_decrypt(aes_key: Union[bytes, str], data: Union[bytes, str]) -> bytes:
    if isinstance(aes_key, str):
        aes_key = aes_key.encode()
    if isinstance(data, str):
        data = data.encode()
    return gcm_decrypt(aes_key, data)


def encrypt_file(
        aes_key: Union[bytes, str],
        source_path: str,
        dest_path: str,
        mode: str = "b",
) -> bool:
    if mode not in ["b", "t"]:
        raise Exception("mode argument error")

    if isinstance(aes_key, str):
        aes_key = aes_key.encode()

    with open(source_path, f"r{mode}") as source, open(
            dest_path, f"w{mode}"
    ) as dest:
        if mode == "b":
            source_b: IO[bytes] = source
            dest_b: IO[bytes] = dest
            plaintext = source_b.read()
            ciphertext = aes_encrypt(aes_key, plaintext)
            dest_b.write(ciphertext)
        else:
            source_t: IO[str] = source
            dest_t: IO[str] = dest
            for plaintext in source_t:
                plaintext = plaintext.rstrip("\n")
                ciphertext = aes_encrypt(aes_key, plaintext)
                dest_t.write(base64.b64encode(ciphertext).decode() + "\n")

    return True


def decrypt_file(
        aes_key: Union[bytes, str],
        source_path: str,
        dest_path: str,
        mode: str = "b",
) -> bool:
    if mode not in ["b", "t"]:
        raise Exception("mode argument error")

    if isinstance(aes_key, str):
        aes_key = aes_key.encode()

    with open(source_path, f"r{mode}") as source, open(
            dest_path, f"w{mode}"
    ) as dest:
        if mode == "b":
            source_b: IO[bytes] = source
            dest_b: IO[bytes] = dest
            ciphertext = source_b.read()
            plaintext = aes_decrypt(aes_key, ciphertext)
            dest_b.write(plaintext)
        else:
            source_t: IO[str] = source
            dest_t: IO[str] = dest
            for ciphertext in source_t:
                ciphertext = ciphertext.rstrip("\n")
                ciphertext = base64.b64decode(ciphertext.encode())
                plaintext = aes_decrypt(aes_key, ciphertext)
                dest_t.write(plaintext.decode() + "\n")
                # dest_t.write(base64.b64encode(plaintext).decode() + "\n")
    return True
