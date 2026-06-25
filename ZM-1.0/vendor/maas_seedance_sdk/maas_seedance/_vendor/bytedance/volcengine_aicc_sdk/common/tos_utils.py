__all__ = ["TOSUtils"]

from urllib import request
from .aes import decrypt_file
import os
import wget
import time
import httpx
from .error import AICCException
from .log import logger


class TOSUtils:
    def __init__(self, workdir: str = "./tmp"):
        self.workdir = workdir
        if not os.path.exists(self.workdir):
            os.makedirs(self.workdir, exist_ok=True)

        self.default_large_file_threshold = 100 * 1024 * 1024
        self.default_download_timeout = 300.0
        self.default_chunk_size = 1024 * 1024

        self.max_retries = 3
        self.retry_delay = 2  # seconds

    def _download_small_file_wget(self, tos_url: str, local_file_path: str) -> bool:
        """
        Download small files using Python wget module
        
        Args:
            tos_url: TOS文件路径
            local_file_path: 本地文件路径
            
        Returns:
            bool: 是否下载成功
        """
        if not tos_url or not local_file_path:
            raise AICCException("TOS URL and local file path are required")

        if os.path.exists(local_file_path):
            raise AICCException("Local file already exists, please delete it first")
        
        for attempt in range(1, self.max_retries + 1):
            try:
                logger.info(f"Download attempt {attempt}/{self.max_retries}")
                
                # Download file using wget
                wget.download(tos_url, local_file_path)
                
                # Verify file was downloaded
                if not os.path.exists(local_file_path):
                    raise AICCException("File download failed, try again...")
                
                file_size = os.path.getsize(local_file_path)
                if file_size == 0:
                    raise AICCException("Downloaded file is empty, try again...")
                
                logger.info(f"Download successful, file size: {file_size} bytes")
                return True
                
            except Exception as e:
                logger.warning(f"Download attempt {attempt} failed: {str(e)}, try again...")
                if os.path.exists(local_file_path):
                    try:
                        os.remove(local_file_path)
                    except:
                        pass
                
                if attempt == self.max_retries:
                    raise AICCException(
                        f"Failed to download encrypted file after {self.max_retries} attempts\n"
                        f"Last error: {str(e)}\n"
                        "Please check:\n"
                        "  1. TOS URL is accessible\n"
                        "  2. Network connection is stable\n"
                        "  3. File exists on TOS"
                    )
                
                logger.info(f"Waiting {self.retry_delay} seconds before retry...")
                time.sleep(self.retry_delay)
                self.retry_delay *= 2
        
        raise AICCException("Download failed unexpectedly")

    def _download_small_file_httpx(self, tos_url: str, local_file_path: str) -> bool:
        """
        Download small files using httpx (fallback when wget is not available)
        
        Args:
            tos_url: TOS文件路径
            local_file_path: Path to save the downloaded file            
        Returns:
            bool: 是否下载成功
        """
        if not tos_url or not local_file_path:
            raise AICCException("TOS URL and local file path are required")

        if os.path.exists(local_file_path):
            raise AICCException("Local file already exists, please delete it first")
        for attempt in range(1, self.max_retries + 1):
            try:
                logger.info(f"Download attempt {attempt}/{self.max_retries}")
                
                # Download file using httpx
                with httpx.stream('GET', tos_url, timeout=self.default_download_timeout, follow_redirects=True) as response:
                    response.raise_for_status()
                    
                    with open(local_file_path, 'wb') as f:
                        for chunk in response.iter_bytes(chunk_size=self.default_chunk_size):
                            f.write(chunk)
                
                # Verify file was downloaded
                if not os.path.exists(local_file_path):
                    raise AICCException("File download failed, try again...")
                
                file_size = os.path.getsize(local_file_path)
                if file_size == 0:
                    raise AICCException("Downloaded file is empty")
                
                logger.info(f"Download successful, file size: {file_size} bytes")
                return True
                
            except Exception as e:
                logger.warning(f"Download attempt {attempt} failed: {str(e)}")
                
                # Clean up failed download
                if os.path.exists(local_file_path):
                    try:
                        os.remove(local_file_path)
                    except:
                        pass
                
                # If this was the last attempt, raise error
                if attempt == self.max_retries:
                    raise AICCException(
                        f"Failed to download encrypted file after {self.max_retries} attempts\n"
                        f"Last error: {str(e)}\n"
                        "Please check:\n"
                        "  1. TOS URL is accessible\n"
                        "  2. Network connection is stable\n"
                        "  3. File exists on TOS"
                    )
                
                # Wait before retry
                logger.info(f"Waiting {self.retry_delay} seconds before retry...")
                time.sleep(self.retry_delay)
                self.retry_delay *= 2

        # Should never reach here, but satisfy type checker
        raise AICCException("Download failed unexpectedly")

    def _download_large_file_streaming(self, tos_url: str, local_file_path: str, expected_size: int) -> bool:
        """
        Download large files using httpx streaming
        
        Args:
            tos_url: TOS文件路径
            local_file_path: Path to save the downloaded file            
            expected_size: Expected file size in bytes
            
        Returns:
            Path to the downloaded file
        """
        if not tos_url or not local_file_path or expected_size <= 0:
            raise AICCException("TOS URL, local file path, and expected file size are required and must be greater than 0")

        if os.path.exists(local_file_path):
            raise AICCException("Local file already exists, please delete it first")

        for attempt in range(1, self.max_retries + 1):
            try:
                logger.info(f"Streaming download attempt {attempt}/{self.max_retries}")
                
                # Streaming download with timeout
                with httpx.stream('GET', tos_url, timeout=self.default_download_timeout, follow_redirects=True) as response:
                    response.raise_for_status()
                    
                    downloaded_bytes = 0
                    
                    with open(local_file_path, 'wb') as f:
                        for chunk in response.iter_bytes(chunk_size=self.default_chunk_size):
                            f.write(chunk)
                            downloaded_bytes += len(chunk)
                            
                            # Log progress every 10MB
                            if downloaded_bytes % (10 * 1024 * 1024) < self.default_chunk_size:
                                progress = (downloaded_bytes / expected_size) * 100 if expected_size > 0 else 0
                                logger.info(f"Download progress: {progress:.1f}% ({downloaded_bytes / (1024*1024):.1f} MB / {expected_size / (1024*1024):.1f} MB)")
                
                # Verify file was downloaded
                if not os.path.exists(local_file_path):
                    raise AICCException("File download failed, try again...")
                
                file_size = os.path.getsize(local_file_path)
                if file_size == 0:
                    raise AICCException("Downloaded file is empty")
                
                logger.info(f"Download successful, file size: {file_size} bytes")
                return True
                
            except Exception as e:
                logger.warning(f"Streaming download attempt {attempt} failed: {str(e)}")
                
                # Clean up failed download
                if os.path.exists(local_file_path):
                    try:
                        os.remove(local_file_path)
                    except:
                        pass
                
                # If this was the last attempt, raise error
                if attempt == self.max_retries:
                    raise AICCException(
                        f"Failed to download large file after {self.max_retries} attempts\n"
                        f"Last error: {str(e)}\n"
                        "Please check:\n"
                        "  1. TOS URL is accessible\n"
                        "  2. Network connection is stable\n"
                        "  3. File exists on TOS\n"
                        "  4. Timeout is sufficient for file size"
                    )
                
                # Wait before retry
                logger.info(f"Waiting {self.retry_delay} seconds before retry...")
                time.sleep(self.retry_delay)
                self.retry_delay *= 2
        
        # Should never reach here, but satisfy type checker
        raise AICCException("Download failed unexpectedly")

    def _extract_filename_from_url(self, url: str) -> str:
        """
        Extract filename from TOS URL
        
        Args:
            url: TOS URL
            
        Returns:
            Filename
        """
        # Remove query parameters
        path = url.split('?')[0]
        filename = os.path.basename(path)
        return filename
    
    def download_file(self, tos_url: str, local_file_path: str, encrypted_key: bytes) -> bool:
        """
        下载文件到本地路径, encrypted_key有值时需要先解密文件, 再保存到本地路径
        :return: 是否成功
        :param tos_url: TOS文件路径
        :param local_file_path: 本地文件路径
        :param encrypted_key: 加密密钥, 为空时表示文件未加密
        """
        if not tos_url or not local_file_path:
            raise AICCException("TOS URL and local file path are required")
        
        if os.path.exists(local_file_path):
            raise AICCException("Local file already exists, please delete it first")
        
        if not tos_url.startswith('http'):
            raise AICCException(f"Invalid TOS URL: {tos_url}\n URL must start with http:// or https://")
        
        try:
            if not self._download_small_file_wget(tos_url, local_file_path):
                raise AICCException("download file from TOS failed failed, please check the URL")

            if encrypted_key:
                tmp_file_path = local_file_path + ".tmp"
                decrypt_file(encrypted_key, local_file_path, tmp_file_path, mode="b")
                os.remove(local_file_path)
                os.rename(tmp_file_path, local_file_path)

            return True

        except AICCException as e:
            logger.error(f"Error extracting filename from TOS URL: {e}")
            raise e
        except Exception as e:
            logger.error(f"Error extracting filename from TOS URL: {str(e)}")
            raise AICCException("download filename from TOS file failed, please check the URL")

    def download_files(self, tos_url: str, local_file_path: str, encrypted_key: bytes) -> bool:
        """
        下载多个文件并合并到,local_file_path, encrypted_key有值时需要先解密文件, 再保存
        :return: 是否成功
        :param tos_url: TOS文件路径
        :param local_file_path: 本地文件路径
        :param encrypted_key: AES加密密钥, 为空时表示文件未加密
        """
        if not tos_url or not local_file_path:
            raise AICCException("TOS URL and local file path are required")
        
        if os.path.exists(local_file_path):
            raise AICCException("Local file already exists, please delete it first")
        
        if not tos_url.startswith('http'):
            raise AICCException(f"Invalid TOS URL: {tos_url}\n URL must start with http:// or https://")
        
        try:
            meta_file_npath = tos_url + "/meta.json" 
            resp = request.urlopen(meta_file_npath)
            resp.raise_for_status()
            meta_json = resp.json()
            logger.info(f"Meta file content: {meta_json}")

            file_list = meta_json.get("files", [])
            if not file_list:
                raise AICCException("No files found in the TOS directory")
            
            # sort file_list by filename
            file_list.sort()

            video_files = []
            for file_name in file_list:
                tos_file_path = tos_url + "/" + file_name
                tmp_file_path = local_file_path + "." + file_name
                if not self._download_small_file_wget(tos_file_path, tmp_file_path):
                    raise AICCException(f"download file from TOS failed failed, please check the URL{tos_file_path}")

                if encrypted_key:
                    decrypt_file_path = tmp_file_path + ".dec"
                    decrypt_file(encrypted_key, tmp_file_path, decrypt_file_path, mode="b")
                    os.remove(tmp_file_path)
                    os.rename(decrypt_file_path, tmp_file_path)

                video_files.append(tmp_file_path)
            
            # 将ret_video_file中的文件合并输出到ret_video_file_path
            with open(local_file_path, 'wb') as f:
                for video_file in video_files:
                    with open(video_file, 'rb') as video:
                        f.write(video.read())

            return True

        except AICCException as e:
            logger.error(f"Error extracting filename from TOS URL: {e}")
            raise e
        except Exception as e:
            logger.error(f"Error extracting filename from TOS URL: {str(e)}")
            raise AICCException("download filename from TOS file failed, please check the URL")
