// 1000kitap Otomatik Begeni Botu - Puppeteer Versiyonu
// GitHub Actions uzerinde calismak uzere tasarlanmistir.
// v3: Gunluk limit + sayfa dongusu eklendi.

const puppeteer = require('puppeteer');
const net       = require('net');

// --- AYARLAR ---
const EMAIL         = process.env.KITAP_EMAIL;
const SIFRE         = process.env.KITAP_SIFRE;
const USE_TOR       = process.env.USE_TOR === 'true';
// Gunluk maksimum begeni limiti (hesap siniri)
const GUNLUK_LIMIT  = parseInt(process.env.GUNLUK_LIMIT || '7500', 10);
const TOR_HOST      = '127.0.0.1';
const TOR_SOCKS5    = 'socks5://127.0.0.1:9050';
const TOR_PORT      = 9051;

// --- GEZILECEK SAYFALAR (sirayla, son sayfa bitince basa doner) ---
const SAYFALAR = [
    'https://1000kitap.com/akis',
    'https://1000kitap.com/takipler',
    'https://1000kitap.com/konu/alinti',
    'https://1000kitap.com/konu/1000kitap',
    'https://1000kitap.com/konu/edebiyat',
    'https://1000kitap.com/konu/duygu-ve-dusunce',
    'https://1000kitap.com/konu/siir',
    'https://1000kitap.com/konu/alinti?s=en-yeniler',
    'https://1000kitap.com/konu/1000kitap?s=en-yeniler',
    'https://1000kitap.com/konu/edebiyat?s=en-yeniler',
    'https://1000kitap.com/konu/duygu-ve-dusunce?s=en-yeniler',
    'https://1000kitap.com/konu/siir?s=en-yeniler',  // <-- son sayfa, biter bitmez akis'e donar
];

// --- HIZ AYARLARI ---
const GECIKME_MIN      = 800;
const GECIKME_MAX      = 2500;
const KAYDIR_MIN       = 600;
const KAYDIR_MAX       = 1000;
const MAX_BOS_KAYDIRMA = 5;
const MOLA_HEDEF_MIN   = 5;
const MOLA_HEDEF_MAX   = 12;
const UZUN_MOLA_MIN    = 4000;
const UZUN_MOLA_MAX    = 7500;

// --- ENGEL TESPİTİ ---
// Bot engellendiginde sayfada gorunebilecek ifadeler
const ENGEL_ISARETLERI = [
    'erişim engellendi', 'erisim engellendi',
    'access denied', 'blocked', 'too many requests',
    'rate limit', 'captcha', 'robot', 'ban',
    '403', '429', '503',
    'unusual traffic', 'suspicious activity',
];

const KALP_SVG_PATH = 'M480-147q-14 0-28.5-5T426-168l-69-63q-106-97-191.5-192.5T80-634q0-94 63-157t157-63q53 0 100 22.5t80 61.5q33-39 80-61.5T660-854q94 0 157 63t63 157q0 115-85 211T602-230l-68 62q-11 11-25.5 16t-28.5 5Zm-38-543q-29-41-62-62.5T300-774q-60 0-100 40t-40 100q0 52 37 110.5T285.5-410q51.5 55 106 103t88.5 79q34-31 88.5-79t106-103Q726-465 763-523.5T800-634q0-60-40-100t-100-40q-47 0-80 21.5T518-690q-7 10-17 15t-21 5q-11 0-21-5t-17-15Zm38 189Z';

// --- YARDIMCI FONKSİYONLAR ---
function bekle(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function rastgeleSayi(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(mesaj) {
    const zaman = new Date().toLocaleTimeString('tr-TR');
    console.log(`[${zaman}] ${mesaj}`);
}

// --- TOR: YENİ DEVRE İSTE (IP değiştir) ---
// Tor control portuna NEWNYM komutu gonderir -> yeni IP adresi alir
function torYeniIP() {
    return new Promise((resolve) => {
        if (!USE_TOR) { resolve(); return; }

        const client = net.createConnection(TOR_PORT, TOR_HOST, () => {
            client.write('AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r\n');
        });
        client.on('data', () => {});
        client.on('end', () => {
            log('[TOR] Yeni IP adresi istendi. 10 sn bekleniyor...');
            setTimeout(resolve, 10000); // Tor yeni devreyi kurarken bekle
        });
        client.on('error', (err) => {
            log('[TOR] IP degisim hatasi (devam ediliyor): ' + err.message);
            resolve();
        });
    });
}

// --- ENGEL TESPİTİ ---
async function engelVarMi(page) {
    // HTTP durum kodu kontrol
    const url = page.url();
    if (url.includes('/403') || url.includes('/blocked') || url.includes('/ban')) {
        return true;
    }

    // Sayfa icerigi kontrol
    const icerik = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
    for (const isamet of ENGEL_ISARETLERI) {
        if (icerik.includes(isamet)) {
            return true;
        }
    }

    // Giris sayfasina yonlendirildiyse (oturum dusmus olabilir)
    if (url.includes('/giris') || url.includes('/login')) {
        return 'giris_gerekli';
    }

    return false;
}

// --- YENİDEN DENEME ile SAYFA YÜKLEME ---
// Herhangi bir hata/engelde ANINDA Tor ile IP degistirir, 3 kez dener.
async function guvenliGit(page, url, girisYapFn, browser, deneme = 1) {
    const MAX_DENEME = 3;

    try {
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        const statusKodu = response ? response.status() : 0;

        if (statusKodu === 403 || statusKodu === 429 || statusKodu === 503) {
            throw new Error('HTTP ' + statusKodu + ' - Sunucu istegi reddetti.');
        }

        const engel = await engelVarMi(page);

        if (engel === 'giris_gerekli') {
            log('[UYARI] Oturum dusmus! Yeniden giris yapiliyor...');
            await girisYapFn(page);
            return await guvenliGit(page, url, girisYapFn, browser, deneme);
        }

        if (engel) {
            throw new Error('Sayfa engellenme belirtisi gosteriyor.');
        }

        return; // Basarili

    } catch (hata) {
        if (deneme >= MAX_DENEME) {
            log('[HATA] ' + MAX_DENEME + ' denemede de acilamadi, sayfa atlaniyor: ' + url);
            throw hata;
        }

        log('[ENGEL] Deneme ' + deneme + '/' + MAX_DENEME + ' basarisiz: ' + hata.message);

        // Hata ne olursa olsun: Tor aktifse HEMEN IP degistir, aktif degilse kisa bekle
        if (USE_TOR) {
            log('[TOR] Baglanti sorunu - yeni IP aliniyor...');
            await torYeniIP();
        } else {
            const bekleme = deneme * rastgeleSayi(30000, 60000); // 30-60sn, 60-120sn
            log('[BEKLE] ' + (bekleme / 1000).toFixed(0) + ' sn bekleniyor...');
            await bekle(bekleme);
        }

        log('[ENGEL] Yeniden deneniyor (' + (deneme + 1) + '. deneme)...');
        return await guvenliGit(page, url, girisYapFn, browser, deneme + 1);
    }
}

// --- GİRİŞ YAPMA ---
// loginPage: Tor OLMAYAN sayfada giris yapilir (Tor girisi engelleyebilir)
async function girisYap(loginPage) {
    log('Giris sayfasina gidiliyor...');

    // networkidle2: sayfa tamamen yuklenip JS render tamamlaninca devam et
    await loginPage.goto('https://1000kitap.com/giris', { waitUntil: 'networkidle2', timeout: 60000 });

    // SPA icin kritik: herhangi bir input gorunene kadar bekle (max 30sn)
    // React/Next.js gibi frameworkler formu gecikmeyle render eder
    log('Input bekleniyor (SPA render icin)...');
    await loginPage.waitForSelector('input', { timeout: 30000 }).catch(() => {
        log('30sn icinde hic input bulunamadi, devam ediliyor...');
    });

    // Debug: sayfa basligini ve URL'yi logla
    const baslik = await loginPage.title().catch(() => '?');
    log('Sayfa: ' + baslik + ' | URL: ' + loginPage.url());

    // Debug: sayfadaki tum input elementlerini logla
    const inputBilgi = await loginPage.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(el => ({
            type: el.type, name: el.name, id: el.id,
            placeholder: el.placeholder, autocomplete: el.autocomplete
        }));
    }).catch(() => []);
    log('Inputlar: ' + JSON.stringify(inputBilgi));

    // Ekran goruntusu al
    await loginPage.screenshot({ path: 'giris-oncesi.png' }).catch(() => {});

    // Genis fallback - herhangi bir email/text tipi input
    const emailInput = await loginPage.$('input[type="email"]')
        || await loginPage.$('input[name="email"]')
        || await loginPage.$('input[name="username"]')
        || await loginPage.$('input[placeholder*="mail"]')
        || await loginPage.$('input[placeholder*="Mail"]')
        || await loginPage.$('input[autocomplete="email"]')
        || await loginPage.$('input[autocomplete="username"]')
        || await loginPage.$('input[type="text"]');

    if (!emailInput) throw new Error('Hicbir email/text input bulunamadi! Sayfa yapisi degismis olabilir.');


    await emailInput.click({ clickCount: 3 });
    await emailInput.type(EMAIL, { delay: rastgeleSayi(80, 150) });

    const sifreInput = await loginPage.$('input[type="password"]');
    if (!sifreInput) throw new Error('Sifre alani bulunamadi!');

    await sifreInput.click({ clickCount: 3 });
    await sifreInput.type(SIFRE, { delay: rastgeleSayi(80, 150) });

    const girisButon = await loginPage.$('button[type="submit"]') || await loginPage.$('input[type="submit"]');
    if (!girisButon) throw new Error('Giris butonu bulunamadi!');

    await bekle(rastgeleSayi(500, 1200));
    await girisButon.click();
    await loginPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    if (loginPage.url().includes('/giris')) {
        throw new Error('Giris basarisiz! Kullanici adi veya sifre hatali olabilir.');
    }

    log('Giris basarili! URL: ' + loginPage.url());
    await bekle(rastgeleSayi(1500, 3000));
}

// --- TEK SAYFADA BEGENi YAPMA ---
// kalanLimit: bu sayfada yapilabilecek maksimum begeni (gunluk limiti asma)
async function sayfadaBegeniYap(page, sayfaUrl, browser, kalanLimit) {
    log('Sayfa yukleniyor: ' + sayfaUrl + ' | Kalan limit: ' + kalanLimit);

    if (kalanLimit <= 0) {
        log('[LIMIT] Bu sayfa baslamadan limit doldu, atlaniyor.');
        return 0;
    }

    try {
        await guvenliGit(page, sayfaUrl, girisYap, browser);
    } catch (_) {
        log('[ATLANDI] Bu sayfa gecildi: ' + sayfaUrl);
        return 0;
    }

    await bekle(rastgeleSayi(2000, 4000));

    let toplamBegeni      = 0;
    let bosKaydirmaSayisi = 0;
    let molaHedefi        = rastgeleSayi(MOLA_HEDEF_MIN, MOLA_HEDEF_MAX);
    let arkaArkayaHata    = 0;
    let torYenileme       = 0;
    const MAX_TOR_YENILEME = 2;

    while (bosKaydirmaSayisi < MAX_BOS_KAYDIRMA) {

        // Gunluk limit kontrolu - her dongu basinda kontrol et
        if (toplamBegeni >= kalanLimit) {
            log('[LIMIT] Sayfa icinde gunluk limite ulasildi! (' + toplamBegeni + '/' + kalanLimit + ')');
            break;
        }

        if (toplamBegeni > 0 && toplamBegeni % 50 === 0) {
            const engel = await engelVarMi(page);
            if (engel === true) {
                log('[ENGEL] Sayfa ortasinda engel tespit edildi! IP degistiriliyor...');
                if (USE_TOR && torYenileme < MAX_TOR_YENILEME) {
                    torYenileme++;
                    await torYeniIP();
                    try {
                        await guvenliGit(page, sayfaUrl, girisYap, browser);
                        await bekle(rastgeleSayi(2000, 4000));
                        bosKaydirmaSayisi = 0; // Sayaci sifirla, icerik tekrar gelecek
                    } catch (_) {
                        log('[ATLANDI] Engel asilamadi, sonraki sayfaya geciliyor.');
                        break;
                    }
                } else {
                    log('[ENGEL] Tor siniri doldu/aktif degil. Sonraki sayfaya geciliyor.');
                    break;
                }
            }
        }

        const butonlar = await page.evaluate((svgPath) => {
            const pathElements = document.querySelectorAll('path[d="' + svgPath + '"]');
            const sonuclar = [];
            pathElements.forEach((path) => {
                const btn = path.closest('button');
                if (btn && btn.offsetParent !== null) {
                    const rect = btn.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        sonuclar.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                    }
                }
            });
            return sonuclar;
        }, KALP_SVG_PATH);

        if (butonlar.length === 0) {
            const kaydirmaMiktari = rastgeleSayi(KAYDIR_MIN, KAYDIR_MAX);
            await page.evaluate((miktar) => window.scrollBy({ top: miktar, behavior: 'smooth' }), kaydirmaMiktari);
            log('Asagi kaydirildi (' + kaydirmaMiktari + 'px) - icerik yok.');
            bosKaydirmaSayisi++;

            // Icerik yuklenmiyorsa (bos kaydirma limiti yariyi gectiyse) Tor devreye gir
            if (bosKaydirmaSayisi >= Math.ceil(MAX_BOS_KAYDIRMA / 2) && USE_TOR && torYenileme < MAX_TOR_YENILEME) {
                log('[TOR] Icerik yuklenmiyor - yeni IP alip sayfa yenileniyor... (' + (torYenileme + 1) + '/' + MAX_TOR_YENILEME + ')');
                torYenileme++;
                await torYeniIP();
                try {
                    await guvenliGit(page, sayfaUrl, girisYap, browser);
                    await bekle(rastgeleSayi(2000, 4000));
                    bosKaydirmaSayisi = 0; // Sayaci sifirla
                    log('[TOR] Sayfa yenilendi, kaldigi yerden devam ediyor...');
                } catch (_) {
                    log('[ATLANDI] Yenileme sonrasi da icerik gelmedi, sonraki sayfaya geciliyor.');
                    break;
                }
            }

            await bekle(rastgeleSayi(1500, 2500));
            continue;
        }

        bosKaydirmaSayisi = 0;
        arkaArkayaHata    = 0;

        for (const buton of butonlar) {
            try {
                await page.mouse.click(buton.x, buton.y);
                toplamBegeni++;
                arkaArkayaHata = 0;
                log('Begeni yapildi! (Bu sayfada: ' + toplamBegeni + ' | Kalan limit: ' + (kalanLimit - toplamBegeni) + ')');

                // Sayfa icinde de limit kontrolu
                if (toplamBegeni >= kalanLimit) {
                    log('[LIMIT] Gunluk limite ulasildi, duruluyor!');
                    break;
                }

                let bekleme = rastgeleSayi(GECIKME_MIN, GECIKME_MAX);

                if (toplamBegeni % molaHedefi === 0) {
                    const uzunMola = rastgeleSayi(UZUN_MOLA_MIN, UZUN_MOLA_MAX);
                    bekleme += uzunMola;
                    molaHedefi = rastgeleSayi(MOLA_HEDEF_MIN, MOLA_HEDEF_MAX);
                    log('Insan molasi: ' + (uzunMola / 1000).toFixed(1) + ' sn bekleniyor...');
                }

                await bekle(bekleme);
            } catch (hata) {
                arkaArkayaHata++;
                log('[HATA] Begeni sirasinda hata (' + arkaArkayaHata + '): ' + hata.message);

                // 5 arka arkaya hata = baglanti sorunu, Tor ile IP degistir ve sayfayi yenile
                if (arkaArkayaHata >= 5) {
                    if (USE_TOR && torYenileme < MAX_TOR_YENILEME) {
                        log('[TOR] Arka arkaya 5 hata - yeni IP alip sayfa yenileniyor...');
                        torYenileme++;
                        await torYeniIP();
                        try {
                            await guvenliGit(page, sayfaUrl, girisYap, browser);
                            await bekle(rastgeleSayi(2000, 4000));
                            bosKaydirmaSayisi = 0;
                            arkaArkayaHata    = 0;
                            log('[TOR] Sayfa yenilendi, devam ediliyor...');
                        } catch (_) {
                            log('[ATLANDI] Yenileme basarisiz, sonraki sayfaya geciliyor.');
                            bosKaydirmaSayisi = MAX_BOS_KAYDIRMA;
                        }
                    } else {
                        log('[ATLANDI] Tor siniri doldu/aktif degil, sayfa atlaniyor.');
                        bosKaydirmaSayisi = MAX_BOS_KAYDIRMA;
                    }
                    break;
                }
            }
        }

        const kaydirmaMiktari = rastgeleSayi(KAYDIR_MIN, KAYDIR_MAX);
        await page.evaluate((miktar) => window.scrollBy({ top: miktar, behavior: 'smooth' }), kaydirmaMiktari);
        await bekle(rastgeleSayi(1500, 2500));
    }

    log('Sayfa tamamlandi: ' + sayfaUrl + ' - Toplam ' + toplamBegeni + ' begeni.');
    return toplamBegeni;
}

// --- ANA FONKSİYON ---
(async () => {
    if (!EMAIL || !SIFRE) {
        console.error('HATA: KITAP_EMAIL ve KITAP_SIFRE ortam degiskenleri ayarlanmamis!');
        process.exit(1);
    }

    log('========================================');
    log('Bot baslatiliyor...');
    log('Gunluk limit : ' + GUNLUK_LIMIT + ' begeni');
    log('Tor          : ' + (USE_TOR ? 'AKTIF' : 'PASIF'));
    log('Sayfa sayisi : ' + SAYFALAR.length);
    log('========================================');

    const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1366,768',
        '--disable-blink-features=AutomationControlled',
    ];

    if (USE_TOR) {
        launchArgs.push('--proxy-server=' + TOR_SOCKS5);
        log('[TOR] Tum trafik Tor uzerinden gececek.');
    }

    const browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
    const page    = await browser.newPage();

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768 });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
        Object.defineProperty(navigator, 'languages',  { get: () => ['tr-TR', 'tr', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'platform',   { get: () => 'Win32' });
    });

    try {
        // --- GİRİŞ STRATEJİSİ ---
        // Tor tum tarayiciya atandiginda giris sayfasi da Tor'dan geciyor ve
        // yavas/engelli aciliyor. Cozum:
        //   1. Tor'suz ayri bir tarayici ile giris yap ve cookie al
        //   2. Cookie'yi Tor'lu sayfaya aktar
        //   3. Tor'suz tarayiciyi kapat

        if (USE_TOR) {
            log('[GIRIS] Tor aktif - giris Tor olmadan yapilacak, sonra cookie aktarilacak...');

            // Tor'suz gecici tarayici
            const loginBrowser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', '--disable-gpu',
                    '--disable-blink-features=AutomationControlled',
                ],
            });
            const loginPage = await loginBrowser.newPage();
            await loginPage.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            );
            await loginPage.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            // Giris yap
            await girisYap(loginPage);

            // Cookie'leri al
            const cookies = await loginPage.cookies();
            log('[GIRIS] ' + cookies.length + ' cookie alindi, Tor sayfasina aktariliyor...');

            // Cookie'leri Tor'lu sayfaya aktar
            await page.setCookie(...cookies);

            // Giris tarayicisini kapat
            await loginBrowser.close();
            log('[GIRIS] Giris tamamlandi. Artık Tor uzerinden devam ediliyor.');
        } else {
            // Tor yoksa direkt giris yap
            await girisYap(page);
        }

        let genelToplam = 0;   // Gunde yapilan toplam begeni
        let tur         = 1;   // Kacinci tam tur oldugu (akis'ten siir-yeni'ye)
        let sayfaIndex  = 0;   // Hangi sayfadayiz

        // SONSUZ DONGU: limit dolana kadar tum sayfalari tekrar tekrar gez
        while (genelToplam < GUNLUK_LIMIT) {
            const kalanLimit = GUNLUK_LIMIT - genelToplam;
            const sayfaUrl   = SAYFALAR[sayfaIndex];

            log('--- Tur ' + tur + ' | Sayfa ' + (sayfaIndex + 1) + '/' + SAYFALAR.length +
                ' | Toplam: ' + genelToplam + '/' + GUNLUK_LIMIT + ' ---');

            const sayfaBegeni = await sayfadaBegeniYap(page, sayfaUrl, browser, kalanLimit);
            genelToplam += sayfaBegeni;

            // Limit doldu mu kontrol
            if (genelToplam >= GUNLUK_LIMIT) {
                log('========================================');
                log('GUNLUK LIMITE ULASILDI!');
                log('Toplam begeni: ' + genelToplam + '/' + GUNLUK_LIMIT);
                log('========================================');
                break;
            }

            // Sonraki sayfaya gec
            sayfaIndex++;

            // Son sayfa (siir-yeni) bitti mi? Basa don (akis'e)
            if (sayfaIndex >= SAYFALAR.length) {
                sayfaIndex = 0;
                tur++;
                log('*** Tum sayfalar tamamlandi! ' + tur + '. tura baslanıyor (akis\'e donuluyor) ***');
                log('*** Simdiye kadar: ' + genelToplam + '/' + GUNLUK_LIMIT + ' begeni ***');
                // Tur arasinda biraz uzun bekle (daha dogal gorunmesi icin)
                const turMolasi = rastgeleSayi(10000, 20000);
                log('Tur arasi mola: ' + (turMolasi / 1000).toFixed(0) + ' sn');
                await bekle(turMolasi);
                continue;
            }

            // Sayfalar arasi kisa bekleme
            const sayfaArasi = rastgeleSayi(3000, 6000);
            log('Sayfalar arasi bekleme: ' + (sayfaArasi / 1000).toFixed(1) + ' sn');
            await bekle(sayfaArasi);
        }

    } catch (hata) {
        log('Kritik hata: ' + hata.message);
        try {
            await page.screenshot({ path: 'hata-ekran.png', fullPage: false });
            log('Hata ekran goruntusu kaydedildi: hata-ekran.png');
        } catch (_) {}
        process.exit(1);
    } finally {
        await browser.close();
        log('Tarayici kapatildi.');
    }
})();
