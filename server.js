const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function loadEnvFile() {
    // .env dosyasi varsa yerel ayarlari once bellekte hazirlar.
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;

    // Satir satir okuma, BOM ve tirnak kaynakli anahtar hatalarini engeller.
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;

        const [rawKey, ...valueParts] = trimmed.split('=');
        const key = rawKey.trim().replace(/^\uFEFF/, '');
        const value = valueParts.join('=').trim().replace(/^['"]|['"]$/g, '');
        if (!process.env[key]) process.env[key] = value;
    }
}

function env(name, fallback = '') {
    // Ortam degiskeni yoksa verilen varsayilani kullanir.
    return String(process.env[name] || fallback).trim();
}

loadEnvFile();

const GEMINI_KEY = env('GEMINI_KEY') || env('GOOGLE_API_KEY');
const GEMINI_MODEL = env('GEMINI_MODEL', 'gemini-2.5-flash');
const HF_TOKEN = env('HF_TOKEN');
const HF_MODEL = env('HF_MODEL', 'meta-llama/Llama-3.3-70B-Instruct');
const HF_API_URL = env('HF_API_URL', 'https://router.huggingface.co/v1/chat/completions');
const AI_BACKEND = env('AI_BACKEND', 'hf').toLowerCase();
const PORT = Number(env('PORT', '8000')) || 8000;
const MEMORY_FILE = path.join(__dirname, 'ai_memory.json');
const HISTORY_FILE = path.join(__dirname, 'chat_history.json');

function getDesktopPath() {
    let d = path.join(process.env.USERPROFILE, 'OneDrive', 'Masaüstü');
    if (!fs.existsSync(d)) d = path.join(process.env.USERPROFILE, 'Desktop');
    return d;
}
function loadMemory() {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return { kullanici_adi:"Dostum", isler:[], bilgiler:{}, sik_kullanilanlar:{} };
}
function saveMemory(m) { fs.writeFileSync(MEMORY_FILE, JSON.stringify(m,null,4),'utf8'); }
function loadHistory() { if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE,'utf8')); return []; }
function saveChat(u,a) {
    const h=loadHistory(); h.push({user:u,ai:a,time:new Date().toLocaleString('tr-TR')});
    if(h.length>200) h.splice(0,h.length-200);
    fs.writeFileSync(HISTORY_FILE,JSON.stringify(h,null,2),'utf8');
}

// Bekleyen tehlikeli işlem (onay sistemi)
let pendingAction = null;

// ===== GEMINI API =====
function parseGeminiText(payload) {
    // Gemini yanitindaki tum text parcalarini birlestirir.
    const parts = payload?.candidates?.[0]?.content?.parts || [];
    return parts.map(part => part.text || '').filter(Boolean).join('\n').trim();
}

function askGemini(prompt, temp = 0.1) {
    return new Promise((resolve, reject) => {
        if (!GEMINI_KEY) {
            reject(new Error('Gemini anahtari eksik. .env icine GEMINI_KEY ekleyin.'));
            return;
        }

        // Gemini REST istegi: tek metin promptu ve kontrollu cikti ayarlari.
        const data = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: temp, maxOutputTokens: 2048 }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body || '{}');
                    const apiMessage = json?.error?.message;

                    if (res.statusCode < 200 || res.statusCode >= 300 || apiMessage) {
                        reject(new Error(apiMessage || `Gemini HTTP ${res.statusCode}`));
                        return;
                    }

                    const text = parseGeminiText(json);
                    if (!text) {
                        reject(new Error('Gemini bos yanit dondurdu.'));
                        return;
                    }

                    resolve(text);
                } catch (error) {
                    reject(new Error(`Gemini yaniti okunamadi: ${error.message}`));
                }
            });
        });

        req.setTimeout(60000, () => {
            req.destroy(new Error('Gemini istegi zaman asimina ugradi.'));
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}
function parseHuggingFaceText(payload) {
    // HF Router yanitindan OpenAI uyumlu mesaj metnini alir.
    return String(payload?.choices?.[0]?.message?.content || '').trim();
}

function extractApiError(prefix, statusCode, body) {
    // JSON hata govdesi varsa okunur, yoksa kisa ham metin doner.
    try {
        const json = JSON.parse(body || '{}');
        const errorBody = json.error;
        if (errorBody && typeof errorBody === 'object') return `${prefix}: ${errorBody.message || statusCode}`;
        return `${prefix}: ${errorBody || json.message || statusCode}`;
    } catch (_) {
        return `${prefix}: HTTP ${statusCode} ${String(body || '').slice(0, 180)}`;
    }
}

function askHuggingFace(prompt, temp = 0.1) {
    return new Promise((resolve, reject) => {
        if (!HF_TOKEN) {
            reject(new Error('HF_TOKEN eksik. .env icine HF_TOKEN ekleyin.'));
            return;
        }

        const endpoint = new URL(HF_API_URL);
        const data = JSON.stringify({
            model: HF_MODEL,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 2048,
            temperature: temp
        });

        const client = endpoint.protocol === 'http:' ? http : https;
        const req = client.request({
            hostname: endpoint.hostname,
            port: endpoint.port || (endpoint.protocol === 'http:' ? 80 : 443),
            path: `${endpoint.pathname}${endpoint.search}`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HF_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Asistan-AI/1.0',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(extractApiError('Hugging Face', res.statusCode, body)));
                        return;
                    }

                    const json = JSON.parse(body || '{}');
                    const text = parseHuggingFaceText(json);
                    if (!text) {
                        reject(new Error('Hugging Face bos yanit dondurdu.'));
                        return;
                    }
                    resolve(text);
                } catch (error) {
                    reject(new Error(`Hugging Face yaniti okunamadi: ${error.message}`));
                }
            });
        });

        req.setTimeout(60000, () => {
            req.destroy(new Error('Hugging Face istegi zaman asimina ugradi.'));
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function askAi(prompt, temp = 0.1) {
    // Web butonlari icin HF birincil, Gemini yedek motor olarak kullanilir.
    const order = AI_BACKEND === 'gemini' ? ['gemini', 'hf'] : ['hf', 'gemini'];
    const errors = [];

    for (const backend of order) {
        try {
            if (backend === 'hf' && HF_TOKEN) return await askHuggingFace(prompt, temp);
            if (backend === 'gemini' && GEMINI_KEY) return await askGemini(prompt, temp);
        } catch (error) {
            errors.push(error.message);
        }
    }

    throw new Error(errors.join(' | ') || 'HF_TOKEN veya GEMINI_KEY bulunamadi.');
}
// ===== KOMUT SINIFLANDIRMA (Gemini ile) =====
async function classifyCommand(userInput) {
    const mem = loadMemory();
    const prompt = `Sen bir komut sınıflandırma sistemisin. Kullanıcının adı: ${mem.kullanici_adi}.
Kullanıcı sana bir komut verecek. Bu komutu aşağıdaki kategorilerden birine sınıflandır ve JSON döndür.
Yazım hataları, argo, kısaltma olabilir, bunları tolere et.

KATEGORİLER:
1. "uygulama_ac" - SADECE bir program/oyun/site açmak istiyorsa (içinde kişi adı YOKSA). param: uygulama adı
2. "whatsapp_islem" - WhatsApp'tan birine mesaj/arama istiyorsa. param: kişi adı, param2: "ara" veya "mesaj"
3. "internet_ara" - İnternette bir şey aramak istiyorsa. param: aranacak şey
4. "haber" - Haber okumak istiyorsa. param: haber konusu
5. "klasor_olustur" - Klasör oluşturmak istiyorsa. param: klasör adı
6. "dosya_olustur" - Metin/not/dosya oluşturmak istiyorsa. param: dosya adı, param2: içerik
7. "dosya_sil" - Dosya/klasör silmek istiyorsa. param: silinecek dosya adı
8. "dosya_ara" - Dosya aramak istiyorsa. param: aranacak kelime
9. "dosya_tasi" - Dosyayı başka yere taşımak istiyorsa. param: dosya adı, param2: hedef klasör
10. "dosya_yeniden_adlandir" - Dosyanın adını değiştirmek istiyorsa. param: eski ad, param2: yeni ad
11. "masaustu_temizle" - Masaüstünü temizlemek istiyorsa
12. "isim_ogren" - Kullanıcı ismini söylüyorsa. param: isim
13. "hafiza_kaydet" - Bilgi hatırlamasını istiyorsa. param: hatırlanacak şey
14. "hafiza_sorgula" - Hakkında ne bilindiğini soruyorsa
15. "gecmis" - Sohbet geçmişini görmek istiyorsa
16. "is_kaydet" - Görev kaydetmek istiyorsa. param: görev
17. "is_listele" - Görevlerini görmek istiyorsa
18. "gunluk_rapor" - Bugün ne yaptığının özetini istiyorsa
19. "onay" - Önceki bir işleme onay/ret veriyorsa (evet, tamam, hayır, iptal)
20. "sohbet" - Yukarıdakilerin hiçbiri değilse veya bilgi sorusu/serbest sohbet

ÖNEMLİ: "whatsapptan ali'yi ara" -> "whatsapp_islem". "evet"/"tamam"/"onaylıyorum"/"hayır"/"iptal" -> "onay".

SADECE JSON döndür:
{"kategori": "...", "param": "...", "param2": "..."}

Kullanıcı komutu: "${userInput}"`;

    let attempts = 0;
    while (attempts < 3) {
        try {
            const raw = await askAi(prompt, 0.1);
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch(e) { console.error('AI siniflandirma hatasi:', e.message); }
        attempts++;
        if (attempts < 3) await new Promise(r => setTimeout(r, 2000));
    }
    return { kategori: 'sohbet', param: userInput };
}

// ===== YARDIMCI FONKSİYONLAR =====
function findShortcuts(dir) {
    let r=[]; if(!fs.existsSync(dir)) return r;
    try { for(const f of fs.readdirSync(dir)){ const p=path.join(dir,f); try{ const s=fs.statSync(p);
        if(s.isDirectory()) r=r.concat(findShortcuts(p));
        else if(f.toLowerCase().endsWith('.lnk')||f.toLowerCase().endsWith('.url')) r.push(p);
    }catch(e){} } }catch(e){} return r;
}
function searchFiles(dir,kw,res=[]) {
    if(!fs.existsSync(dir)) return res;
    try { for(const f of fs.readdirSync(dir)){ const p=path.join(dir,f);
        try{ const s=fs.statSync(p); if(s.isDirectory()) searchFiles(p,kw,res);
        else if(f.toLowerCase().includes(kw.toLowerCase())) res.push(p); }catch(e){}
    } }catch(e){} return res;
}
function downloadFile(url,dest) {
    return new Promise((ok,fail)=>{ const g=url.startsWith('https')?https:http;
        g.get(url,r=>{ if(r.statusCode===301||r.statusCode===302){ const g2=r.headers.location.startsWith('https')?https:http;
            g2.get(r.headers.location,r2=>{r2.pipe(fs.createWriteStream(dest)).on('finish',ok);}).on('error',fail);
        } else { r.pipe(fs.createWriteStream(dest)).on('finish',ok); } }).on('error',fail); });
}

// ===== ANA KOMUT ÇALIŞTIRICI =====
async function executeCommand(command) {
    const mem = loadMemory();
    const desktop = getDesktopPath();
    const ad = mem.kullanici_adi || 'Dostum';

    // Gemini ile komutu sınıflandır
    const intent = await classifyCommand(command);
    console.log('🧠 Niyet:', JSON.stringify(intent));

    // ========== ONAY SİSTEMİ ==========
    if (intent.kategori === 'onay') {
        const p = (intent.param || '').toLowerCase();
        if (pendingAction && (p.includes('evet') || p.includes('tamam') || p.includes('onayl'))) {
            const action = pendingAction;
            pendingAction = null;
            try {
                if (action.type === 'dosya_sil') {
                    const s = fs.statSync(action.target);
                    if (s.isDirectory()) fs.rmSync(action.target,{recursive:true,force:true});
                    else fs.unlinkSync(action.target);
                    return `✅ "<b>${path.basename(action.target)}</b>" başarıyla silindi!`;
                }
                if (action.type === 'masaustu_temizle') {
                    const cd = action.cleanDir; let mv=0;
                    for (const f of fs.readdirSync(desktop)) {
                        const fp = path.join(desktop,f);
                        if (fs.statSync(fp).isFile()&&!f.endsWith('.lnk')&&!f.endsWith('.ini')) {
                            fs.mkdirSync(cd,{recursive:true}); fs.renameSync(fp,path.join(cd,f)); mv++;
                        }
                    }
                    return mv > 0 ? `✅ ${mv} dosyayı topladım!` : 'Masaüstü zaten temiz!';
                }
            } catch(e) { return `Hata: ${e.message}`; }
        } else if (pendingAction && (p.includes('hayır') || p.includes('iptal') || p.includes('vazgeç'))) {
            pendingAction = null;
            return '❌ İşlem iptal edildi.';
        }
        if (!pendingAction) return 'Onay bekleyen bir işlem yok.';
    }

    switch(intent.kategori) {

    case 'uygulama_ac': {
        const app = (intent.param || '').toLowerCase();
        const specials = {
            'whatsapp':'start whatsapp:','whatsap':'start whatsapp:','spotify':'start spotify:',
            'discord':'start discord:','telegram':'start tg:','steam':'start steam:',
            'chrome':'start chrome','firefox':'start firefox','edge':'start msedge',
            'opera':'start opera','youtube':'start https://www.youtube.com',
            'instagram':'start https://www.instagram.com','twitter':'start https://www.twitter.com',
            'tiktok':'start https://www.tiktok.com','netflix':'start https://www.netflix.com',
            'notepad':'start notepad','not defteri':'start notepad','paint':'start mspaint',
            'hesap makinesi':'start calc','dosya yöneticisi':'start explorer',
        };
        for(const [k,v] of Object.entries(specials)) { if(app.includes(k)){ exec(v); return `Açıyorum: ${k}!`; } }
        // Kısayol ara
        const sc=[...findShortcuts(desktop),
            ...findShortcuts(path.join(process.env.PUBLIC||'C:\\Users\\Public','Desktop')),
            ...findShortcuts(path.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs')),
            ...findShortcuts(path.join(process.env.PROGRAMDATA||'C:\\ProgramData','Microsoft','Windows','Start Menu','Programs'))];
        for(const s of sc){ if(path.basename(s).toLowerCase().includes(app)){ exec(`explorer "${s}"`); return `Açıyorum: ${path.basename(s,path.extname(s))}!`; } }
        return `"${intent.param}" bulamadım. Yüklü olduğundan emin misin?`;
    }

    case 'whatsapp_islem': {
        const kisi = intent.param || '';
        const islem = (intent.param2 || 'ara').toLowerCase();
        // WhatsApp'ı aç
        exec('start whatsapp:');
        if (kisi) {
            return `WhatsApp'ı açtım! 📱 Lütfen WhatsApp'ta "<b>${kisi}</b>" kişisini bul ve ${islem === 'mesaj' ? 'mesaj gönder' : 'ara'}. (Kişi listesine doğrudan erişim güvenlik nedeniyle tarayıcıdan yapılamıyor.)`;
        }
        return 'WhatsApp açıldı! Kimi aramak istiyorsan arama çubuğuna yaz.';
    }

    case 'internet_ara': {
        const q = encodeURIComponent(intent.param||command);
        exec(`start https://www.google.com/search?q=${q}`);
        return `Google'da "<b>${intent.param}</b>" arıyorum!`;
    }

    case 'haber': {
        if(intent.param){
            exec(`start https://www.google.com/search?q=${encodeURIComponent(intent.param+' haber')}&tbm=nws`);
            return `"<b>${intent.param}</b>" haberlerini açıyorum!`;
        }
        exec('start https://news.google.com/home?hl=tr&gl=TR');
        return "Google Haberler'i açıyorum!";
    }

    case 'klasor_olustur': {
        const name = intent.param || 'Yeni_Klasor';
        const dir = path.join(desktop, name.replace(/\s/g,'_'));
        fs.mkdirSync(dir,{recursive:true});

        // Orijinal komutta fotoğraf/resim/köpek indirme isteği var mı?
        const cmdLow = command.toLowerCase();
        if (cmdLow.includes('köpek') || cmdLow.includes('kopek')) {
            let ok = 0;
            for (let i = 0; i < 3; i++) {
                try {
                    const url = await (new Promise((resolve, reject) => {
                        https.get('https://dog.ceo/api/breeds/image/random', r => {
                            let d=''; r.on('data',c=>d+=c);
                            r.on('end',()=>{ try{resolve(JSON.parse(d).message);}catch(e){reject(e);} });
                        }).on('error', reject);
                    }));
                    await downloadFile(url, path.join(dir, `kopek_${i+1}.jpg`));
                    ok++;
                } catch(e) {}
            }
            return `"<b>${name}</b>" klasörünü oluşturdum ve içine ${ok} köpek fotoğrafı indirdim! 🐶`;
        }

        return `Masaüstünde "<b>${name}</b>" klasörünü oluşturdum!`;
    }

    case 'dosya_olustur': {
        let fname = (intent.param||'yeni_belge').replace(/\s/g,'_');
        if(!fname.includes('.')) fname+='.txt';
        const content = intent.param2 || `Bu dosya Asistan AI tarafindan olusturuldu.\nTarih: ${new Date().toLocaleString('tr-TR')}`;
        fs.writeFileSync(path.join(desktop,fname), content, 'utf8');
        return `Masaüstünde "<b>${fname}</b>" oluşturdum!<br>İçerik: <i>${content.substring(0,100)}</i>`;
    }

    case 'dosya_sil': {
        const found = searchFiles(desktop, intent.param||'');
        if(found.length>0){
            // GÜVENLİK: Onay iste
            pendingAction = { type: 'dosya_sil', target: found[0] };
            return `⚠️ <b>Güvenlik Onayı:</b> "<b>${path.basename(found[0])}</b>" dosyasını silmek istediğinizden emin misiniz?<br><br>Onaylamak için <b>"evet"</b>, iptal için <b>"hayır"</b> yazın.`;
        }
        return `"${intent.param}" bulamadım.`;
    }

    case 'dosya_ara': {
        const found = searchFiles(desktop, intent.param||'');
        if(found.length>0){
            let r=`<b>${found.length}</b> dosya buldum:<br>`;
            found.slice(0,5).forEach((f,i)=>r+=`<br><b>${i+1}.</b> ${path.basename(f)}`);
            return r;
        }
        return `"${intent.param}" bulamadım.`;
    }

    case 'dosya_tasi': {
        const found = searchFiles(desktop, intent.param||'');
        if (found.length > 0) {
            const hedef = path.join(desktop, (intent.param2||'Tasindi').replace(/\s/g,'_'));
            fs.mkdirSync(hedef, {recursive:true});
            const src = found[0];
            fs.renameSync(src, path.join(hedef, path.basename(src)));
            return `"<b>${path.basename(src)}</b>" dosyasını "<b>${intent.param2}</b>" klasörüne taşıdım!`;
        }
        return `"${intent.param}" bulamadım.`;
    }

    case 'dosya_yeniden_adlandir': {
        const found = searchFiles(desktop, intent.param||'');
        if (found.length > 0) {
            const src = found[0];
            let newName = intent.param2 || 'yeni_ad';
            if (!path.extname(newName)) newName += path.extname(src);
            const dest = path.join(path.dirname(src), newName);
            fs.renameSync(src, dest);
            return `"<b>${path.basename(src)}</b>" -> "<b>${newName}</b>" olarak yeniden adlandırıldı!`;
        }
        return `"${intent.param}" bulamadım.`;
    }

    case 'masaustu_temizle': {
        // GÜVENLİK: Onay iste
        const d=new Date().toLocaleDateString('tr-TR').replace(/\./g,'_');
        const cd=path.join(desktop,`Temizlik_${d}`);
        // Kaç dosya etkilenecek say
        let count = 0;
        for(const f of fs.readdirSync(desktop)){
            if(fs.statSync(path.join(desktop,f)).isFile()&&!f.endsWith('.lnk')&&!f.endsWith('.ini')) count++;
        }
        if (count === 0) return 'Masaüstü zaten temiz!';
        pendingAction = { type: 'masaustu_temizle', cleanDir: cd };
        return `⚠️ <b>Güvenlik Onayı:</b> Masaüstündeki <b>${count}</b> dosya '${path.basename(cd)}' klasörüne toplanacak.<br><br>Onaylamak için <b>"evet"</b>, iptal için <b>"hayır"</b> yazın.`;
    }

    case 'isim_ogren': {
        const name = intent.param||'';
        if(name){ mem.kullanici_adi=name.charAt(0).toUpperCase()+name.slice(1); saveMemory(mem);
            return `Memnun oldum <b>${mem.kullanici_adi}</b>! Seni kaydettim.`; }
        return 'İsmini anlayamadım.';
    }

    case 'hafiza_kaydet': {
        if(!mem.bilgiler) mem.bilgiler={};
        mem.bilgiler['not_'+(Object.keys(mem.bilgiler).length+1)] = intent.param;
        saveMemory(mem);
        return `Kaydettim: "<b>${intent.param}</b>"`;
    }

    case 'hafiza_sorgula': {
        let info=`${ad}, işte bildiklerim:<br><br>👤 <b>İsim:</b> ${ad}<br>`;
        if(mem.bilgiler&&Object.keys(mem.bilgiler).length>0){
            info+=`<br>📝 <b>Notlarım:</b><br>`;
            for(const [k,v] of Object.entries(mem.bilgiler)) info+=`- ${v}<br>`;
        }
        if(mem.isler&&mem.isler.length>0) info+=`<br>📋 <b>Görevlerin:</b> ${mem.isler.join(', ')}<br>`;
        return info;
    }

    case 'gecmis': {
        const h=loadHistory(); if(!h.length) return 'Henüz geçmiş yok.';
        let o=`📜 <b>Son mesajlar:</b><br><br>`;
        h.slice(-8).forEach(x=>o+=`<span style="color:#94a3b8;font-size:.8em">${x.time}</span><br>👤 ${x.user}<br>🤖 ${x.ai.replace(/<[^>]*>/g,'').substring(0,80)}<br><br>`);
        return o;
    }

    case 'is_kaydet': {
        if(!mem.isler) mem.isler=[];
        mem.isler.push(intent.param); saveMemory(mem);
        return `Görevi kaydettim: "<b>${intent.param}</b>"`;
    }

    case 'is_listele': {
        if(mem.isler&&mem.isler.length>0){
            let o=`${ad}, görevlerin:<br>`;
            mem.isler.forEach((x,i)=>o+=`<br><b>${i+1}.</b> ${x}`);
            return o;
        }
        return 'Kayıtlı görev yok.';
    }

    case 'gunluk_rapor': {
        const history = loadHistory();
        const bugun = new Date().toLocaleDateString('tr-TR');
        const todayMsgs = history.filter(h => h.time && h.time.includes(bugun));

        if (todayMsgs.length === 0) return 'Bugün henüz hiçbir komut vermedin.';

        let rapor = `📊 <b>Günlük Rapor - ${bugun}</b><br><br>`;
        rapor += `📝 Toplam <b>${todayMsgs.length}</b> komut verdin.<br><br>`;

        // Komut türlerini say
        let types = {};
        todayMsgs.forEach(m => {
            const msg = m.user.toLowerCase();
            if (/aç|ac/.test(msg)) types['Uygulama Açma'] = (types['Uygulama Açma']||0)+1;
            else if (msg.includes('ara')) types['Arama'] = (types['Arama']||0)+1;
            else if (msg.includes('sil')) types['Silme'] = (types['Silme']||0)+1;
            else if (msg.includes('klasör') || msg.includes('dosya')) types['Dosya İşlemi'] = (types['Dosya İşlemi']||0)+1;
            else if (msg.includes('temizle')) types['Temizlik'] = (types['Temizlik']||0)+1;
            else types['Sohbet'] = (types['Sohbet']||0)+1;
        });

        rapor += `📈 <b>Komut Dağılımı:</b><br>`;
        for (const [k,v] of Object.entries(types)) rapor += `- ${k}: ${v} kez<br>`;

        rapor += `<br>⏰ <b>İlk komut:</b> ${todayMsgs[0].time}<br>`;
        rapor += `⏰ <b>Son komut:</b> ${todayMsgs[todayMsgs.length-1].time}<br>`;

        return rapor;
    }

    case 'sohbet': default: {
        // Son konuşmaları al (bağlam için)
        const history = loadHistory().slice(-6);
        let convoContext = '';
        if (history.length > 0) {
            convoContext = '\n\nÖnceki konuşmalarınız:\n';
            history.forEach(h => {
                convoContext += `Kullanıcı: ${h.user}\nAsistan AI: ${h.ai.replace(/<[^>]*>/g,'').substring(0,150)}\n`;
            });
        }

        let memContext = '';
        if (mem.bilgiler && Object.keys(mem.bilgiler).length > 0) {
            memContext = '\n\nKullanıcı hakkında bildiklerin:\n';
            for (const [k,v] of Object.entries(mem.bilgiler)) memContext += `- ${v}\n`;
        }
        if (mem.isler && mem.isler.length > 0) {
            memContext += `\nKullanıcının görevleri: ${mem.isler.join(', ')}\n`;
        }

        const chatPrompt = `Sen "Asistan AI" adında, son derece zeki, esprili, samimi ve bilgili bir Türkçe yapay zeka asistanısın.
Kişiliğin: Zeki, şakacı ama saygılı, yardımsever, meraklı. Kullanıcıyla arkadaş gibi konuşuyorsun.
Kullanıcının adı: ${ad}.
${memContext}${convoContext}

ÖNEMLİ KURALLAR:
- Her zaman Türkçe yanıt ver
- Doğal, akıcı ve insan gibi konuş
- Gerektiğinde uzun ve detaylı cevap ver, gerektiğinde kısa ve öz ol
- Bilgi sorularına doğru ve kapsamlı yanıt ver (bilim, tarih, teknoloji, günlük hayat vs.)
- Kodlama, matematik, yazı yazma gibi konularda yardım edebilirsin
- Önceki konuşmaları hatırla ve bağlamı koru
- Emoji kullanabilirsin ama abartma
- Eğer bilmiyorsan dürüstçe söyle

Kullanıcının mesajı: "${command}"`;

        try {
            let reply = '';
            for (let i = 0; i < 3; i++) {
                reply = await askAi(chatPrompt, 0.7);
                if (reply) break;
                await new Promise(r => setTimeout(r, 2000));
            }
            return reply || `Merhaba ${ad}! Şu an yapay zeka motoruna yoğun istek gidiyor. Birkaç saniye sonra tekrar dener misin? 😊`;
        } catch(e) {
            console.error('Sohbet hatasi:', e.message);
            return `Yapay zeka motoruna baglanamadim: ${e.message}`;
        }
    }
    }
}

// ===== HTTP SUNUCUSU =====
function writeJson(res, statusCode, payload) {
    // JSON cevaplari tek noktadan standartlastirir.
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function serveIndex(res) {
    // Arayuzu sunucudan vererek file:// ve onbellek sorunlarini azaltir.
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.end(html);
}

const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        serveIndex(res);
        return;
    }

    if (req.method === 'GET' && pathname === '/history') {
        writeJson(res, 200, loadHistory().slice(-50));
        return;
    }

    if (req.method === 'DELETE' && pathname === '/history') {
        fs.writeFileSync(HISTORY_FILE, '[]', 'utf8');
        writeJson(res, 200, { ok: true });
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { command } = JSON.parse(body || '{}');
                if (!command || !String(command).trim()) {
                    writeJson(res, 400, { response: 'Komut bos olamaz.' });
                    return;
                }

                console.log(`Komut: ${command}`);
                const response = await executeCommand(String(command));
                console.log(`Yanit: ${response}\n`);
                saveChat(command, response);
                writeJson(res, 200, { response });
            } catch (error) {
                console.error('Sunucu hatasi:', error.message);
                writeJson(res, 500, { response: `Sunucu hatasi: ${error.message}` });
            }
        });
        return;
    }

    writeJson(res, 404, { response: 'Bulunamadi.' });
});

server.listen(PORT, () => {
    console.log('============================================================');
    console.log('ASISTAN AI SUNUCU BASLATILDI');
    console.log(`Adres: http://127.0.0.1:${PORT}`);
    console.log(`Birincil motor: ${AI_BACKEND === 'gemini' ? 'Gemini' : 'Hugging Face'}`);
    console.log(`HF Model: ${HF_MODEL}`);
    console.log(`Gemini Model: ${GEMINI_MODEL}`);
    console.log('============================================================');
});
