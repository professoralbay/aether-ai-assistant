import os
import json
import queue
import logging
import threading
import subprocess
import requests
import numpy as np
import sounddevice as sd
import speech_recognition as sr
import shutil
import time
import pyautogui
from datetime import datetime
from hf_engine import HuggingFaceChatEngine

# ==============================================================================
# 1. TEMEL YAPILANDIRMA VE LOGLAMA
# ==============================================================================
#logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
MEMORY_FILE = "ai_memory.json"
OLLAMA_URL = "http://127.0.0.1:11434/api/generate"
HF_SYSTEM_PROMPT = "Sen Asistan AI adinda kisa, net ve Turkce cevap veren yardimci bir asistansin."

class AsistanEngine:
    """
    Asistan AI Çekirdek Motoru.
    Ses işleme, komut yürütme ve hafıza yönetimini optimize eder.
    """
    
    def __init__(self):
        self.running = True
        self.audio_queue = queue.Queue() # Ses paketleri için kuyruk
        self.recognizer = sr.Recognizer() # Ses tanıma motoru
        self.desktop_path = self._get_desktop() # Dinamik masaüstü yolu
        self.memory = self._load_memory() # Kalıcı hafıza
        self.update_log("Asistan Sistemi Hazırlanıyor...")
        self.hf_engine = self._build_hf_engine() # Hugging Face sohbet motoru

    def update_log(self, text):
        """Sistem durumunu konsola düzenli bir şekilde yansıtır."""
        print(f"[ASISTAN] {text}")

    def _get_desktop(self):
        """Kullanıcının masaüstü yolunu otomatik tespit eder."""
        # OneDrive masaüstü yolunu dene
        path = os.path.join(os.path.expanduser("~"), "OneDrive", "Masaüstü")
        if not os.path.exists(path):
            # Standart masaüstü yolunu dene
            path = os.path.join(os.path.expanduser("~"), "Desktop")
        return path

    def _load_memory(self):
        """AI hafızasını JSON dosyasından yükler."""
        if os.path.exists(MEMORY_FILE):
            try:
                with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                return {"kullanici_adi": "Dostum", "isler": []}
        return {"kullanici_adi": "Dostum", "isler": []}

    def _build_hf_engine(self):
        """Hugging Face motorunu güvenli şekilde başlatır."""
        try:
            return HuggingFaceChatEngine.from_env(os.path.join(os.path.dirname(__file__), ".env")) # .env tabanlı kurulum
        except Exception as exc:
            self.update_log(f"HF motoru pasif: {exc}") # Token yoksa uygulama tamamen çökmez
            return None

    # ==============================================================================
    # 2. SES İŞLEME MODÜLÜ (OPTIMIZED VOICE ENGINE)
    # ==============================================================================
    def audio_callback(self, indata, frames, time, status):
        """Mikrofondan gelen ses paketlerini kuyruğa iletir."""
        if status:
            print(f"Ses Hatası: {status}")
        self.audio_queue.put(indata.copy())

    def voice_listener(self):
        """Arka planda sürekli çalışarak sesleri komuta dönüştürür."""
        try:
            # Varsayılan mikrofon bilgilerini al
            device_info = sd.query_devices(kind='input')
            samplerate = int(device_info['default_samplerate'])
            # Ses akışını başlat
            with sd.InputStream(samplerate=samplerate, channels=1, callback=self.audio_callback):
                self.update_log(f"Dinleme Başladı: {device_info['name']}")
                while self.running:
                    audio_chunks = []
                    # Yaklaşık 3 saniyelik ses verisi topla
                    for _ in range(int(samplerate / 1024 * 3)):
                        try:
                            audio_chunks.append(self.audio_queue.get(timeout=1))
                        except queue.Empty:
                            break
                    
                    if not audio_chunks:
                        continue
                    
                    # Ses verisini işlenebilir formata getir
                    audio_data = (np.concatenate(audio_chunks).flatten() * 32767).astype(np.int16)
                    audio_instance = sr.AudioData(audio_data.tobytes(), samplerate, 2)
                    
                    try:
                        # Google Ses Tanıma Servisi
                        text = self.recognizer.recognize_google(audio_instance, language='tr-TR').lower()
                        self.update_log(f"Komut: {text}")
                        self.process_command(text)
                    except sr.UnknownValueError:
                        continue # Ses anlaşılamadı
                    except Exception as e:
                        continue
        except Exception as e:
            self.update_log(f"Ses Motoru Başlatılamadı: {e}")

    # ==============================================================================
    # 3. KOMUT VE AI YÖNETİMİ
    # ==============================================================================
    def process_command(self, cmd):
        """Komutları analiz eder ve yürütür."""
        # Masaüstü Temizlik Komutu
        if "masaüstü" in cmd and "temizle" in cmd:
            self.clean_desktop()
        
        # Klasör Oluşturma
        elif "klasör oluştur" in cmd:
            folder_name = cmd.replace("klasör oluştur", "").strip() or "Yeni Klasör"
            os.makedirs(os.path.join(self.desktop_path, folder_name), exist_ok=True)
            self.update_log(f"Klasör oluşturuldu: {folder_name}")
            
        # Pencere Kapatma
        elif "kapat" in cmd or "pencereyi kapat" in cmd:
            pyautogui.hotkey('alt', 'f4')
            self.update_log("Aktif pencere kapatıldı.")
            
        # Tanımlı komut yoksa yapay zekaya (LLAVA) sor
        else:
            response = self.ask_ai(cmd)
            self.update_log(f"Asistan Yanıtı: {response}")

    def clean_desktop(self):
        """Masaüstündeki tüm dosyaları arşiv klasörüne taşıyarak temizlik yapar."""
        archive_name = f"Asistan_Arşiv_{datetime.now().strftime('%d_%m_%Y')}"
        archive_path = os.path.join(self.desktop_path, archive_name)
        
        count = 0
        for item in os.listdir(self.desktop_path):
            item_path = os.path.join(self.desktop_path, item)
            # Sadece dosyaları taşı, kısayolları ve klasörleri bırak
            if os.path.isfile(item_path) and not item.endswith((".lnk", ".ini")):
                os.makedirs(archive_path, exist_ok=True)
                shutil.move(item_path, os.path.join(archive_path, item))
                count += 1
        
        self.update_log(f"{count} dosya '{archive_name}' klasörüne taşındı.")

    def ask_ai(self, prompt):
        """Önce Hugging Face, gerekirse yerel Ollama ile yanıt üretir."""
        clean_prompt = prompt.strip() # Modele boşlukları temizlenmiş komut gönderilir

        if self.hf_engine: # HF token varsa birincil motor olarak kullanılır
            try:
                return self.hf_engine.ask(clean_prompt, system=HF_SYSTEM_PROMPT) # Kısa Türkçe yanıt istenir
            except Exception as exc:
                self.update_log(f"HF hatası: {exc}") # HF hatası loglanır, yerel yedeğe düşülür

        try:
            payload = {
                "model": "llava", # Yerel Ollama modeli yedek motor olarak kalır
                "prompt": f"Kullanıcı: {clean_prompt}. Sen Asistan AI asistanisin. Kisa ve dogal cevap ver.",
                "stream": False
            }
            res = requests.post(OLLAMA_URL, json=payload, timeout=15) # Yerel motor kısa timeout ile denenir
            return res.json().get('response', 'Yanıtsız.') # Ollama yanıt metni alınır
        except Exception as exc:
            self.update_log(f"Ollama hatası: {exc}") # İkinci motor hatası da görünür olur
            return "Yapay zeka motoruna ulaşılamıyor, ancak sistem komutlarınız çalışıyor."

    def start(self):
        """Ana motoru ve arka plan dinleme thread'ini başlatır."""
        self.update_log("Asistan AI Tüm Sistemleriyle Hazır.")
        # Ses motorunu arka planda başlat
        threading.Thread(target=self.voice_listener, daemon=True).start()
        
        # Ana programı canlı tut
        try:
            while self.running:
                time.sleep(1)
        except KeyboardInterrupt:
            self.running = False

if __name__ == "__main__":
    asistan = AsistanEngine()
    asistan.start()
