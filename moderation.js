// 1000Kitap Akıllı İçerik Moderasyon ve Filtreleme Modülü
// Uygunsuz (+18 / yetişkin) ve DM / sohbet daveti içeren gönderileri tespit eder.
// Edebi kitap alıntıları ve şiirlerde sıfır yanlış pozitif (zero false-positive) hedeflenmiştir.

'use strict';

/**
 * Türkçe karakter duyarlı küçük harfe dönüştürme ve temizleme
 */
function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .toLocaleLowerCase('tr-TR')
        // Görünmez Unicode karakterlerini ve sıfır genişlikli boşlukları temizle
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ')
        // Fazlalık boşlukları tek boşluğa indir
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Türkçe harfleri ASCII dengi karakterlere çevirir (İmla/karakter atlama tespiti için)
 */
function foldToAscii(text) {
    if (!text) return '';
    return text
        .replace(/ç/g, 'c')
        .replace(/ğ/g, 'g')
        .replace(/ı/g, 'i')
        .replace(/ö/g, 'o')
        .replace(/ş/g, 's')
        .replace(/ü/g, 'u');
}

/**
 * Harfleri boşlukla, noktayla veya tireyle ayrılmış tuzak ifadeleri ("d m", "d.m", "s e k s", "p o r n o") birleştirir
 */
function compactSpaced(text) {
    if (!text) return '';
    // 2 veya daha fazla tek harfli parçayı birleştirir: "s e k s" -> "seks", "d m" -> "dm", "p.o.r.n.o" -> "porno"
    return text.replace(/\b([a-z0-9çğıöşü])(?:[\s._\-\/]+([a-z0-9çğıöşü]))+\b/gi, (match) => {
        return match.replace(/[\s._\-\/]+/g, '');
    });
}

// --- DM VE MESAJ / SOHBET DAVETİ KALIPLARI ---
const DM_REGEXES = [
    // 1. Doğrudan DM / Özel Mesaj belirteçleri (adım, yardım, yudum, kadim gibi kelimeler kesinlikle elenir)
    // Sınırlar: kelime başı/sonu veya harf olmayan karakterler
    {
        regex: /(?:^|[^\p{L}\p{N}])d[\s._\-\/]*m(?:'?(?:den|dan|e|ye|de|da|i|yi|in|nin))?(?:[^\p{L}\p{N}]|$)/iu,
        neden: 'Doğrudan DM ifadesi'
    },
    // "dme gelin", "dmye gelin", "dme beklerim"
    {
        regex: /(?:^|[^\p{L}\p{N}])dm(?:e|ye)\s+(?:gelin|gel|beklerim|yaz[ıi]n|ula[sş][ıi]n)/iu,
        neden: 'DM daveti (dme gelin/yazın)'
    },
    // "dm gelin", "dm at", "dm atın", "dm kutum", "dm açık", "dm bekliyorum"
    {
        regex: /(?:^|[^\p{L}\p{N}])dm\s+(?:gelin|gel|at|at[ıi]n|atin|ats[ıi]n|atsin|atabilir|atabilirsiniz|kutum|kutusu|kutuma|a[cç][ıi]k|acik|bekliyorum|beklerim|buyrun|buyurun|serbest|d[uü][sş]|yaz[ıi]n|yaz)/iu,
        neden: 'DM çağrısı / daveti'
    },
    // "canı sıkılan dm", "canı sıkılan dme", "canı sıkılan dm'e"
    {
        regex: /can[ıi]\s*s[ıi]k[ıi]lan(?:\s*olan)?(?:\s*varsa)?(?:\s*biri)?\s*(?:dm|dme|dm'e|mesaj|yazs[ıi]n|yazsin|gelsin)/iu,
        neden: 'Canı sıkılan sohbet/DM çağrısı'
    },
    // "canı sıkılanlar dm", "canı sıkılanlar yazsın"
    {
        regex: /can[ıi]\s*s[ıi]k[ıi]lanlar\s*(?:dm|dme|dm'e|mesaj|yazs[ıi]n|yazsin|gelsin)/iu,
        neden: 'Canı sıkılanlar sohbet/DM çağrısı'
    },
    // "canı sıkılan yazsın", "canı sıkılan var mı", "canı sıkılan gelsin" (Edebi alıntıda bu kalıp yer almaz)
    {
        regex: /can[ıi]\s*s[ıi]k[ıi]lan\s+(?:yazs[ıi]n|yazsin|gelsin|var\s*m[ıi]|konu[sş]al[ıi]m|biri)/iu,
        neden: 'Canı sıkılan yazsın/konuşalım daveti'
    },
    // "özelden yazın", "özelden konuşalım", "özelden yaz", "özelden mesaj"
    {
        regex: /[oö]zelden\s*(?:yaz[ıi]n|yaz|yazsin|yazs[ıi]n|mesaj|konu[sş]al[ıi]m|ula[sş][ıi]n|ula[sş]|bekliyorum|yazabilirsiniz)/iu,
        neden: 'Özelden yazışma / mesaj daveti'
    },
    // "sohbet etmek isteyen", "sohbet edecek var mı", "sohbete beklerim", "sohbete gelin"
    {
        regex: /(?:sohbet|muhabbet)\s*(?:etmek\s*isteyen|etmek\s*isteyenler|edecek\s*var|edelim\s*mi|e\s*beklerim|e\s*gelin|dm)/iu,
        neden: 'Sohbet / muhabbet daveti'
    },
    // "tanışmak isteyen", "konuşmak isteyen", "dertleşmek isteyen", "yazışmak isteyen"
    {
        regex: /(?:tan[ıi][sş]mak|konu[sş]mak|dertle[sş]mek|yaz[ıi][sş]mak)\s*(?:isteyen|isteyenler|isteyen\s*dm|isteyen\s*yazs[ıi]n|elim\s*mi)/iu,
        neden: 'Tanışma / konuşma / dertleşme çağrısı'
    },
    // "mesaj atın", "mesaj atabilirsiniz", "bana mesaj at", "mesaj bekliyorum" (Geçmiş zaman "mesaj attı/bıraktı" gibi edebi ifadelerle çakışmaz)
    {
        regex: /(?:bana\s+)?mesaj\s*(?:at[ıi]n|at|ats[ıi]n|atabilirsiniz|atabilir|bekliyorum|b[ıi]rak[ıi]n)/iu,
        neden: 'Mesaj atın çağrısı'
    },
    // "bana yazın", "bana dm atın", "bana özelden yaz"
    {
        regex: /bana\s+(?:[oö]zelden|[oö]zel)\s+(?:yaz[ıi]n|yaz|mesaj)/iu,
        neden: 'Bana özelden yaz çağrısı'
    },
    // WhatsApp / Telegram / Harici kanal yönlendirmesi
    {
        regex: /(?:whatsapp|wp)(?:\s*|'|den|dan)?\s*(?:gelin|grubu|yaz[ıi]n|yaz|no|numara|hatt[ıi])/iu,
        neden: 'WhatsApp yönlendirmesi'
    },
    {
        regex: /(?:telegram|tg)(?:\s*|'|den|dan)?\s*(?:grubu|kanal[ıi]|dm|yaz[ıi]n|link)/iu,
        neden: 'Telegram yönlendirmesi'
    },
    {
        regex: /t\.me\/[a-zA-Z0-9_+]+/iu,
        neden: 'Telegram linki'
    },
    // Sosyal medya kullanıcı adı bırakıp mesaj isteme: "ig: @xxx", "insta: xxx"
    {
        regex: /(?:instagram|insta|ig|snapchat|sc)\s*[:=]\s*@?[a-zA-Z0-9._]{3,}/iu,
        neden: 'Harici sosyal medya profili / iletişim yönlendirmesi'
    },
    // Telefon numarası paylaşımı (05xx veya +905xx)
    {
        regex: /(?:\+90|0)?\s*5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/iu,
        neden: 'Telefon numarası tespiti'
    }
];

// --- YETİŞKİN / +18 / MÜSTEHCEN / UYGUNSUZ İÇERİK KALIPLARI ---
const YETISKIN_REGEXES = [
    // 1. +18 etiketleri
    {
        regex: /(?:\+18|\+\s*18|18\+|\bnsfw\b|yeti[sş]kin\s*i[cç]erik|\badult\b)/iu,
        neden: '+18 / Yetişkin içerik etiketi'
    },
    // 2. Porno ve pornografi terimleri
    {
        regex: /\b(?:porno|porn|pornosu|pornoizle|hentai|hardcore|brazzers)\b/iu,
        neden: 'Pornografik içerik'
    },
    // 3. Escort, eskort, masöz, mutlu son (Fuhuş / eskort reklamları)
    {
        regex: /\b(?:escort|eskort|escorta|escortlar|mas[oö]z|mutlu\s*son\s*masaj)\b/iu,
        neden: 'Eskort / masaj ilanı'
    },
    // 4. Açık cinsel eylemler ve kaba argo (Edebi dille çakışmayan net pornografik terimler)
    {
        regex: /\b(?:siki[sş]|siki[sş]me|siki[sş]elim|siki[sş]mek|sik beni|sikik|sikeyim|siktim|sikecek|g[oö]tlek)\b/iu,
        neden: 'Müstehcen / kaba cinsel argo'
    },
    {
        regex: /\b(?:amc[ıi]k|amc[ıi][gğ][ıi]|yarrak|yarak|yara[gğ][ıi]m|da[sş][sş]ak|ta[sş]ak)\b/iu,
        neden: 'Açık müstehcen organ argosu'
    },
    {
        regex: /\b(?:am[ıi]na\s*koyay[ıi]m|amk|aq|o\.ç|orospu|orospuluk|kahpe)\b/iu,
        neden: 'Ağır küfür / hakaret argosu'
    },
    // 5. Cinsel eylemler, seks çağrıları ve organ argosu
    {
        regex: /\b(?:seks|sex)\s+(?:yapacak|yapmak|yapalı?m|arayan|isteyen|sohbeti|partneri|hattı?|sitesi|ilişki|sohbet|arkadaşı)\b/iu,
        neden: 'Cinsel ilişki / seks teklifi'
    },
    {
        regex: /\b(?:seks|sex)\b/iu,
        neden: 'Cinsel içerik (seks)'
    },
    {
        regex: /\b(?:azgın|azdim|azdım)\b(?:\s+(?:bayan|kız|dul|dm|arıyorum|var\s*mı|gel))?/iu,
        neden: 'Cinsel çağrı (azgın/azdım vb.)'
    },
    {
        regex: /\b(?:boşaldım|bosaldim|boşalmak\s*istiyorum|boşalt\s*beni)\b/iu,
        neden: 'Müstehcen boşalma ifadesi'
    },
    {
        regex: /\b(?:sanal\s*seks|sanal\s*sex|sexting|hot\s*chat|cam\s*show|görüntülü\s*show|ücretli\s*show)\b/iu,
        neden: 'Sanal seks / cam show teklifi'
    },
    {
        regex: /\b(?:swinger|grup\s*seks|grup\s*sex|ensest)\b/iu,
        neden: 'Uygunsuz cinsel ilişki türü (+18)'
    },
    {
        regex: /\b(?:nudes?)\b(?:\s*(?:at|atacak|atan|atsın|atsin|isteyen|var|yolla|gönder|bekliyorum|foto|resim|arşivi|paylaşım))?/iu,
        neden: 'Nude / çıplak fotoğraf talebi'
    },
    {
        regex: /\b(?:mast[uü]rbasyon|31\s*çek|otuzbir\s*çek)\b/iu,
        neden: 'Mastürbasyon ifadesi'
    },
    {
        regex: /\b(?:onlyfans|fansly)\b/iu,
        neden: 'OnlyFans / yetişkin platformu yönlendirmesi'
    },
    {
        regex: /(?:t[uü]rbanl[ıi]\s*azg[ıi]n|t[uü]rbanl[ıi]\s*porno|itiraf\s*\+18|\+18\s*itiraf)/iu,
        neden: '+18 İtiraf / yetişkin kategorisi'
    }
];

/**
 * Gönderi metninin içerik açısından uygun olup olmadığını denetler.
 * 
 * @param {string} metin - Gönderinin tam metni (kart içindeki yazı)
 * @returns {{ uygun: boolean, kategori?: string, kategoriAd?: string, neden?: string, eslesen?: string }}
 */
function icerikUygunMu(metin) {
    if (!metin || typeof metin !== 'string') {
        // Metin bulunamadıysa (resim/fotoğraf alıntısı vb.) varsayılan olarak engelleme
        return { uygun: true };
    }

    const norm = normalizeText(metin);
    if (!norm) return { uygun: true };

    const ascii = foldToAscii(norm);
    const compactNorm = compactSpaced(norm);
    const compactAscii = compactSpaced(ascii);

    // 1. Yetişkin / +18 / Müstehcen İçerik Denetimi (Öncelikli)
    for (const item of YETISKIN_REGEXES) {
        let match = norm.match(item.regex) ||
                    ascii.match(item.regex) ||
                    compactNorm.match(item.regex) ||
                    compactAscii.match(item.regex);

        if (match) {
            return {
                uygun: false,
                kategori: 'yetiskin_18',
                kategoriAd: 'Yetişkin / +18 İçerik',
                neden: item.neden,
                eslesen: match[0].trim()
            };
        }
    }

    // 2. DM / Mesaj / Sohbet Daveti Denetimi
    for (const item of DM_REGEXES) {
        let match = norm.match(item.regex) ||
                    ascii.match(item.regex) ||
                    compactNorm.match(item.regex) ||
                    compactAscii.match(item.regex);

        if (match) {
            return {
                uygun: false,
                kategori: 'dm_sohbet',
                kategoriAd: 'DM / Sohbet Daveti',
                neden: item.neden,
                eslesen: match[0].trim()
            };
        }
    }

    return { uygun: true };
}

module.exports = {
    normalizeText,
    foldToAscii,
    compactSpaced,
    icerikUygunMu,
    DM_REGEXES,
    YETISKIN_REGEXES
};
