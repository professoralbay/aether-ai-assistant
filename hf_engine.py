"""Hugging Face chat motoru.

Bu modul Asistan'in Python tarafinda HF Router uzerinden sohbet yaniti uretir.
Token kodda tutulmaz; `.env` veya ortam degiskeninden okunur.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_MODEL = "meta-llama/Llama-3.3-70B-Instruct"
DEFAULT_API_URL = "https://router.huggingface.co/v1/chat/completions"


def load_env(env_path: str | Path = ".env") -> None:
    """Basit `.env` okuyucu; ek paket gerektirmez."""
    path = Path(env_path)  # Dosya yolu Path nesnesine cevrilir.
    if not path.exists():  # .env yoksa sessizce devam edilir.
        return

    for line in path.read_text(encoding="utf-8-sig").splitlines():  # BOM dahil UTF-8 okunur.
        clean_line = line.strip()  # Satir basi/sonu bosluklari temizlenir.
        if not clean_line or clean_line.startswith("#") or "=" not in clean_line:
            continue  # Bos, yorum veya hatali satirlar atlanir.

        key, value = clean_line.split("=", 1)  # Ilk esittenden anahtar/deger ayrilir.
        key = key.strip()  # Anahtar cevresindeki bosluklar kaldirilir.
        value = value.strip().strip('"').strip("'")  # Deger tirnaklardan arindirilir.
        os.environ.setdefault(key, value)  # Mevcut ortam degeri ezilmez.


@dataclass(frozen=True, slots=True)
class HuggingFaceConfig:
    """HF motor ayarlarini tek yerde toplar."""

    token: str  # Hugging Face erisim tokeni.
    model: str = DEFAULT_MODEL  # Kullanilacak sohbet modeli.
    api_url: str = DEFAULT_API_URL  # OpenAI uyumlu HF Router adresi.
    timeout: int = 60  # HTTP istegi zaman asimi saniyesi.

    @classmethod
    def from_env(cls) -> "HuggingFaceConfig":
        """Ayarlari ortam degiskenlerinden uretir."""
        token = os.getenv("HF_TOKEN", "").strip()  # Token .env/ortamdan alinir.
        if not token:  # Token yoksa erken ve anlasilir hata verilir.
            raise RuntimeError("HF_TOKEN eksik. .env icine HF_TOKEN ekleyin.")

        return cls(
            token=token,  # Gizli bilgi sadece bellekte tutulur.
            model=os.getenv("HF_MODEL", DEFAULT_MODEL).strip(),  # Model istege gore degisebilir.
            api_url=os.getenv("HF_API_URL", DEFAULT_API_URL).strip(),  # Endpoint override edilebilir.
            timeout=int(os.getenv("HF_TIMEOUT", "60")),  # Timeout .env ile ayarlanabilir.
        )


class HuggingFaceChatEngine:
    """HF Router ile kisa ve guvenli sohbet yaniti uretir."""

    def __init__(self, config: HuggingFaceConfig) -> None:
        self.config = config  # Dogrulanmis konfig motor icinde saklanir.

    @classmethod
    def from_env(cls, env_path: str | Path = ".env") -> "HuggingFaceChatEngine":
        """`.env` dosyasini okuyup hazir motor dondurur."""
        load_env(env_path)  # Yerel ayarlar belleğe yuklenir.
        return cls(HuggingFaceConfig.from_env())  # Dogrulanmis config ile motor kurulur.

    def ask(self, prompt: str, *, system: str | None = None, max_tokens: int = 350, temperature: float = 0.4) -> str:
        """Prompt gonderir ve modelin duz metin yanitini dondurur."""
        user_prompt = prompt.strip()  # Bosluk temizligi yapilir.
        if not user_prompt:  # Bos komut modele gonderilmez.
            return "Komut bos geldi. Ne yapmami istersin?"

        messages = []  # Chat Completions formatinda mesaj listesi hazirlanir.
        if system:  # Sistem mesaji varsa once eklenir.
            messages.append({"role": "system", "content": system.strip()})
        messages.append({"role": "user", "content": user_prompt})  # Kullanici mesaji eklenir.

        payload: dict[str, Any] = {
            "model": self.config.model,  # HF Router uzerinde calisacak model.
            "messages": messages,  # OpenAI uyumlu konusma govdesi.
            "max_tokens": max_tokens,  # Yanit uzunlugu kontrol edilir.
            "temperature": temperature,  # Yaraticilik dusuk/orta tutulur.
        }
        request = self._build_request(payload)  # HTTP istegi tek yerde hazirlanir.

        try:
            with urlopen(request, timeout=self.config.timeout) as response:  # Standart kutuphane ile POST atilir.
                raw_body = response.read().decode("utf-8")  # Byte yanit metne cevrilir.
        except HTTPError as exc:
            raise RuntimeError(self._extract_http_error(exc)) from exc  # HF hata govdesi okunur.
        except URLError as exc:
            raise RuntimeError(f"Hugging Face baglanti hatasi: {exc.reason}") from exc  # Ag hatasi acik yazilir.

        data = json.loads(raw_body)  # Basarili yanit JSON olarak cozumlenir.
        answer = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
        if not answer:  # Bos cevap acik hata olarak ele alinir.
            raise RuntimeError("Hugging Face bos yanit dondurdu.")
        return answer  # Temiz metin cagiriciya verilir.

    def _build_request(self, payload: dict[str, Any]) -> Request:
        """HF Router POST istegini olusturur."""
        body = json.dumps(payload).encode("utf-8")  # JSON govde UTF-8 byte'a cevrilir.
        headers = {
            "Authorization": f"Bearer {self.config.token}",  # Token yalnizca HTTP header icinde kullanilir.
            "Content-Type": "application/json",  # Sunucuya JSON gonderildigi bildirilir.
            "Accept": "application/json",  # JSON yanit tercih edilir.
            "User-Agent": "Asistan-AI/1.0",  # Varsayilan Python ajaninin engellenmesi onlenir.
        }
        return Request(self.config.api_url, data=body, headers=headers, method="POST")  # POST request dondurulur.

    @staticmethod
    def _extract_http_error(error: HTTPError) -> str:
        """HF hata yanitini kisa ve okunur metne indirger."""
        raw_body = error.read().decode("utf-8", errors="replace")  # Hata govdesi guvenli okunur.
        try:
            body = json.loads(raw_body)  # JSON hata govdesi denenir.
        except json.JSONDecodeError:
            return f"Hugging Face HTTP {error.code}: {raw_body[:200]}"

        error_body = body.get("error")  # HF genellikle hatayi `error` alaninda dondurur.
        if isinstance(error_body, dict):  # OpenAI uyumlu hata formati desteklenir.
            return str(error_body.get("message") or f"Hugging Face HTTP {error.code}")
        return str(error_body or body.get("message") or f"Hugging Face HTTP {error.code}")
