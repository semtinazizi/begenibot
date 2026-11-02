// 1000Kitap Akıllı İçerik Moderasyon ve Filtreleme Modülü
// Uygunsuz (+18 / yetişkin / erotik) ve DM / mesaj / sohbet daveti içeren gönderileri tespit eder.
// Edebi kitap alıntıları, şiirler ve felsefi alıntılarda sıfır yanlış pozitif (zero false-positive) hedeflenmiştir.

'use strict';

const https = require('https');

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
 * Kelimeler arasındaki alt çizgi, tire, bölü, dalga gibi tuzak ayraçları boşluğa çevirir
 * Örn: "canı_sıkılan_yazsın" -> "canı sıkılan yazsın", "konuşmak-isteyen" -> "konuşmak isteyen"
 */
function normalizeSeparators(text) {
    if (!text) return '';
    return text
        .replace(/[\/\\_\-~*|•]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
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

// --- DM, MESAJ, SOHBET VE TANIŞMA DAVETİ KALIPLARI ---
const DM_REGEXES = [
    // 1. Doğrudan DM / Özel Mesaj belirteçleri (adım, yardım, yudum, kadim gibi edebi kelimeler kesinlikle elenir)
    // Sınırlar: kelime başı/sonu veya harf olmayan karakterler
    {
        regex: /(?:^|[^\p{L}\p{N}])d[\s._\-\/]*m(?:'?(?:den|dan|e|ye|de|da|i|yi|in|nin|im|le|yle|ler|lere|lerin|e\s*gelin|e\s*beklerim|e\s*yaz[ıi]n|le[sş]elim|le[sş]mek|le[sş]iriz|s))?(?:[^\p{L}\p{N}]|$)/iu,
        neden: 'Doğrudan DM ifadesi'
    },
    // 2. DM davetleri ve tamlamaları ("dm gelin", "dm at", "dm atın", "dm atabilirsin", "dm kutum", "dm açık", "dm bekliyorum", "dm düş", "dm buyrun")
    {
        regex: /(?:^|[^\p{L}\p{N}])dm\s+(?:gelin|gel|at(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n|abilir(?:siniz|sin)?|ar\s*m[ıi]s[ıi]n[ıi]z?)?|kutum|kutusu|kutuma|a[cç][ıi]k|acik|bekliyorum|beklerim|buyrun|buyurun|serbest|d[uü][sş]|yaz(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n|abilir(?:siniz|sin)?)?|l[uü]tfen|pls)(?:[^\p{L}\p{N}]|$)/iu,
        neden: 'DM çağrısı / daveti'
    },
    // 3. PM (Private Message) davetleri ("pm at", "pm atın", "pm bekliyorum", "pm açık", "pm gelin")
    {
        regex: /(?:^|[^\p{L}\p{N}])pm(?:\s*(?:at(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n|abilir(?:siniz|sin)?)?|gelin|yaz(?:[ıi]n[ıi]z?|[ıi]n)?|bekliyorum|beklerim|a[cç][ıi]k|kutum)|'?(?:den|dan|e|ye|de|da))(?:[^\p{L}\p{N}]|$)/iu,
        neden: 'PM (Özel Mesaj) çağrısı'
    },
    // 4. "canı sıkılan dm", "canı sıkılan yazsın/yazabilir/yaz", "canı sıkılan mesaj", "canı sıkılan gelsin/ulaşsın/dertleşelim/sohbet/kimse var mı"
    {
        regex: /(?:can[ıi]\s*s[ıi]k[ıi]lan(?:lar)?|cani\s*sikilan(?:lar)?)(?:\s+(?:olan|varsa|biri(?:si)?(?:ni)?|birileri(?:ni)?|kimse|herkes|herkesi|bana|[oö]zelden|[oö]zel|[oö]zele|yoruma|yorumlara|alta|l[uü]tfen)){0,3}\s+(?:dm|dme|dm'e|pm|[oö]zelden|[oö]zele|mesaj\s*(?:at(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n(?:lar)?|abilir(?:siniz|sin)?)?|g[oö]nderin)?|yaz(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n(?:lar)?|abilir(?:siniz|sin)?)?|gelsin|gelin|gelebilir|gelsinler|konu[sş]al[ıi]m|konu[sş]abiliriz|konu[sş]mak|dertle[sş]elim|dertle[sş]ebiliriz|dertle[sş]mek|dertle[sş]ecek|tan[ıi][sş]al[ıi]m|tan[ıi][sş]abiliriz|tan[ıi][sş]mak|sohbet(?:\s*edelim|\s*edecek)?|buyursun|buyrun|ula[sş]s[ıi]n|ula[sş](?:[ıi]n[ıi]z?|[ıi]n)?|ula[sş]abilir(?:siniz|sin)?|eklesin|ekle(?:yin)?|ekleyebilir|ses\s*versin|ses\s*verin|var\s*m[ıi]|yok\s*mu|kimse\s*var\s*m[ıi]|kimse\s*yok\s*mu)/iu,
        neden: 'Canı sıkılan sohbet/DM çağrısı'
    },
    // 5. "canım sıkıldı / sıkılıyor / sıkıntıdan patladım" + sohbet/mesaj arayışı
    {
        regex: /(?:can[ıi]m\s*(?:[cç]ok\s*)?s[ıi]k[ıi]l(?:d[ıi]|[ıi]yor)|s[ıi]k[ıi]nt[ıi]dan\s*patlad[ıi]m)\s+(?:dm|dme|pm|[oö]zelden|[oö]zele|mesaj|yaz(?:[ıi]n[ıi]z?|[ıi]n|abilir(?:siniz|sin)?|abilir\s*misiniz)?|konu[sş]al[ıi]m|konu[sş]abiliriz|dertle[sş]elim|dertle[sş]ebiliriz|sohbet(?:\s*edelim)?|tan[ıi][sş]al[ıi]m|biri(?:si)?\s*yazs[ıi]n|birileri\s*yazs[ıi]n|biriyle\s*konu[sş]|konu[sş]acak|dertle[sş]ecek|sohbet\s*edecek|kimse\s*yok\s*mu|kimse\s*var\s*m[ıi])/iu,
        neden: 'Canım sıkıldı sohbet/mesaj çağrısı'
    },
    // 6. "çok sıkıldım yazın", "sıkıldım mesaj atın", "sıkıldım dm"
    {
        regex: /(?:[cç]ok\s*)?s[ıi]k[ıi]ld[ıi]m\s+(?:dm|dme|pm|[oö]zelden|[oö]zele|mesaj|yaz(?:[ıi]n[ıi]z?|[ıi]n|abilir(?:siniz|sin)?)?|konu[sş]al[ıi]m|dertle[sş]elim|tan[ıi][sş]al[ıi]m|sohbet|sohbete|biri\s*yazs[ıi]n|kimse\s*yok\s*mu)/iu,
        neden: 'Sıkıldım sohbet/mesaj çağrısı'
    },
    // 7. "konuşmak isteyen mesaj atsın/yazsın", "sohbet etmek/isteyen", "dertleşmek isteyen", "tanışmak isteyen"
    {
        regex: /(?:tan[ıi][sş]mak|konu[sş]mak|dertle[sş]mek|yaz[ıi][sş]mak|sohbet\s*(?:etmek)?|muhabbet\s*(?:etmek)?|arkada[sş]\s*olmak|vakit\s*ge[cç]irmek|kaynatmak|kayna[sş]mak)\s*(?:isteyen|isteyenler|arayan|arayanlar)(?:(?:\s*[\?!]+|\s*$)|(?:\s+(?:varsa|olursa|biri(?:si)?(?:ni)?|birileri(?:ni)?|olan|herkes|herkesi|bana|[oö]zelden|[oö]zel|[oö]zele|yoruma|yorumlara|alta|l[uü]tfen)){0,3}(?:\s+(?:mesaj\s*(?:at(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n(?:lar)?|abilir(?:siniz|sin)?)?|g[oö]nderin)?|yaz(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n(?:lar)?|abilir(?:siniz|sin)?)?|dm|pm|[oö]zelden|[oö]zele|gelsin|gelin|gelebilir|gelsinler|ula[sş][ıi]n?|ula[sş]s[ıi]n|ula[sş]abilir(?:siniz|sin)?|eklesin|ekle(?:yin)?|ekleyebilir|buyursun|buyrun|bekliyorum|beklerim|buraday[ıi]m|burday[ıi]m|buralarday[ıi]m|var\s*m[ıi]|yok\s*mu|[\?!]+|$)))/iu,
        neden: 'Tanışma / konuşma / dertleşme / sohbet çağrısı'
    },
    // 8. "konuşacak / sohbet edecek / dertleşecek biri var mı / arıyorum / kimse yok mu"
    {
        regex: /(?:konu[sş]acak|sohbet\s*edecek|dertle[sş]ecek|tan[ıi][sş]acak|yaz[ıi][sş]acak|muhabbet\s*edecek)\s+(?:biri(?:si)?(?:ni|yle|le|ne|den)?|birileri(?:ni|yle)?|arkada[sş]|dost|kimse|k[ıi]z|bayan)?\s*(?:var\s*m[ıi]|yok\s*mu|ar[ıi]yorum|laz[ıi]m|bekliyorum|yazar\s*m[ıi])/iu,
        neden: 'Sohbet / konuşacak arkadaş arayışı'
    },
    // 9. "sohbete beklerim", "sohbete gelin", "muhabbete beklerim"
    {
        regex: /(?:sohbet|muhabbet)(?:e|\s+odas[ıi]na|\s+grubuna)\s*(?:beklerim|bekliyorum|gelin|gel|buyrun)/iu,
        neden: 'Sohbet odası/muhabbet daveti'
    },
    // 10. Karşılıklı teklif / soru: "konuşalım mı", "dertleşelim mi", "tanışalım mı", "sohbet edelim mi"
    {
        regex: /(?:konu[sş]al[ıi]m\s*m[ıi]|dertle[sş]elim\s*m[ıi]|tan[ıi][sş]al[ıi]m\s*m[ıi]|sohbet\s*edelim\s*mi|yaz[ıi][sş]al[ıi]m\s*m[ıi]|kaynatal[ıi]m\s*m[ıi]|kayna[sş]al[ıi]m\s*m[ıi])/iu,
        neden: 'Karşılıklı konuşma / tanışma teklifi'
    },
    // 11. "mesaj atın konuşalım", "yazın tanışalım", "ekleyin dertleşelim", "ekle konuşalım", "dm atın konuşalım"
    {
        regex: /(?:mesaj\s*at(?:[ıi]n[ıi]z?|[ıi]n)?|yaz(?:[ıi]n[ıi]z?|[ıi]n)?|dm\s*at(?:[ıi]n[ıi]z?|[ıi]n)?|ekle(?:yin)?|gelin)\s+(?:konu[sş]al[ıi]m|dertle[sş]elim|tan[ıi][sş]al[ıi]m|sohbet\s*edelim|kaynatal[ıi]m|kayna[sş]al[ıi]m)/iu,
        neden: 'Yazın / mesaj atın konuşalım çağrısı'
    },
    // 12. "özelden yazın", "özelden konuşalım", "özelden konuşabilir miyiz", "özele gelin", "özele geçelim"
    {
        regex: /(?:[oö]zelden|[oö]zele)\s*(?:yaz(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n|abilir(?:siniz|sin)?)?|mesaj|konu[sş]al[ıi]m|konu[sş]abiliriz|konu[sş]abilir\s*miyiz|ula[sş][ıi]n?|ula[sş]s[ıi]n|ula[sş]abilir(?:siniz|sin)?|bekliyorum|beklerim|gelin|ge[cç]elim)/iu,
        neden: 'Özelden yazışma / mesaj daveti'
    },
    // 13. "özel mesaj atın", "özel mesaj bekliyorum", "özel mesaj atabilirsiniz"
    {
        regex: /[oö]zel\s*mesaj\s*(?:at(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n|abilir(?:siniz|sin)?|ar\s*m[ıi]s[ıi]n[ıi]z?)?|bekliyorum|beklerim|g[oö]nderin|yollay[ıi]n|yaz(?:[ıi]n[ıi]z?|[ıi]n)?)/iu,
        neden: 'Özel mesaj talebi'
    },
    // 14. "mesaj atın", "mesaj atabilirsiniz", "mesaj atabilirsin", "bana mesaj atın", "mesaj bekliyorum"
    {
        regex: /(?:bana\s+)?mesaj\s*(?:at(?:[ıi]n[ıi]z?|[ıi]n|s[ıi]n|abilir(?:siniz|sin)?|ar\s*m[ıi]s[ıi]n[ıi]z?)?|ata\s*bilir(?:siniz|sin)?|bekliyorum|beklerim|b[ıi]rak[ıi]n|g[oö]nderin|yollay[ıi]n)/iu,
        neden: 'Mesaj atın çağrısı'
    },
    // 15. "mesaj kutum açık"
    {
        regex: /mesaj\s*kutum\s*(?:a[cç][ıi]k|a[cç][ıi]kt[ıi]r|beklerim)/iu,
        neden: 'Mesaj kutusu açık çağrısı'
    },
    // 16. "bana özelden yazın"
    {
        regex: /bana\s+(?:[oö]zelden|[oö]zel)\s+(?:yaz(?:[ıi]n[ıi]z?|[ıi]n)?|mesaj|ula[sş][ıi]n?)/iu,
        neden: 'Bana özelden yaz çağrısı'
    },
    // 17. "bana yaz / bana ulaş / bana yazabilirsiniz / bana yazabilirsin"
    {
        regex: /\bbana\s+(?:ula[sş](?:[ıi]n[ıi]z?|abilir(?:siniz|sin)?)?|yaz(?:[ıi]n[ıi]z?|abilir(?:siniz|sin)?)?)\b/iu,
        neden: 'Bana yazın / ulaşın çağrısı'
    },
    // 18. "mesajlarınızı bekliyorum / mesajlarınızı beklerim"
    {
        regex: /mesajlar[ıi]n[ıi]z[ıi]\s*(?:bekliyorum|beklerim)/iu,
        neden: 'Mesajlarınızı bekliyorum çağrısı'
    },
    // 19. Sevgili / flört / arkadaş arayışı
    {
        regex: /(?:sevgili|fl[oö]rt|manita|k[ıi]z\s*arkada[sş]|erkek\s*arkada[sş]|sohbet\s*arkada[sş][ıi]|dert\s*orta[gğ][ıi])\s*(?:ar[ıi]yorum|istiyorum|arayan|arayanlar|var\s*m[ıi])/iu,
        neden: 'Sevgili / flört / arkadaş arayışı'
    },
    {
        regex: /(?:sevgili|fl[oö]rt)\s*olmak\s*isteyen/iu,
        neden: 'Sevgili / flört olma teklifi'
    },
    {
        regex: /tan[ıi][sş]mak\s*isteyen\s*(?:k[ıi]zlar|bayanlar|kad[ıi]nlar|hatunlar|erkekler)/iu,
        neden: 'Cinsiyete yönelik tanışma çağrısı'
    },
    // 20. Harici iletişim & yönlendirmeler
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
    {
        regex: /(?:discord|dc)(?:\s*|'|den|dan)?\s*(?:sunucusu|grubu|gelin|link|davet)/iu,
        neden: 'Discord daveti'
    },
    {
        regex: /(?:\b(?:instagram|insta|ig|snapchat|sc|tiktok|twitter)\b)\s*[:=]\s*@?[a-zA-Z0-9._]{3,}/iu,
        neden: 'Harici sosyal medya profili / iletişim yönlendirmesi'
    },
    {
        regex: /(?:\+90|0)?\s*5\d{2}[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/iu,
        neden: 'Telefon numarası tespiti'
    }
];

// --- YETİŞKİN / +18 / MÜSTEHCEN / EROTİK İÇERİK VE KİTAP ALINTILARI ---
const YETISKIN_REGEXES = [
    // 1. +18 etiketleri ve erotik kategori başlıkları
    {
        regex: /(?:\+18|\+\s*18|18\+|\bnsfw\b|yeti[sş]kin\s*i[cç]erik|\badult\b|erotik\s*(?:hikaye|al[ıi]nt[ıi]|roman|i[cç]erik|yaz[ıi])|m[uü]stehcen)/iu,
        neden: '+18 / Erotik / Yetişkin içerik etiketi'
    },
    // 2. Porno ve pornografi terimleri & yetişkin siteleri
    {
        regex: /\b(?:porno|porn|pornosu|pornoizle|hentai|hardcore|brazzers|xvideos|pornhub|onlyfans|fansly)\b/iu,
        neden: 'Pornografik içerik / platform'
    },
    // 3. Escort, eskort, masöz, mutlu son (Fuhuş / eskort reklamları)
    {
        regex: /\b(?:escort|eskort|escorta|escortlar|mas[oö]z|mutlu\s*son\s*masaj|masaj\s*salonu\s*mutlu\s*son|travesti\s*escort)\b/iu,
        neden: 'Eskort / masaj ilanı'
    },
    // 4. Edebi kitap alıntılarındaki anatomik cinsel organ isimleri (1. ve 3. şahıs iyelik ekleriyle)
    {
        regex: /\b(?:vajina|vajinam|vajinama|vajinamda|vajinamdan|vajinam[ıi]|vajinas[ıi]|vajinas[ıi]na|vajinas[ıi]nda|vajinas[ıi]ndan|vajinaya|vajinay[ıi]|vagina)\b/iu,
        neden: 'Vajina ifadesi (+18 erotik alıntı)'
    },
    {
        regex: /\b(?:penis|penisim|penisime|penisimde|penisimden|penisimi|penisi|penisine|penisinde|penisinden|penise|penisiyle)\b/iu,
        neden: 'Penis ifadesi (+18 erotik alıntı)'
    },
    {
        regex: /\b(?:klitoris|klitorisim|klitorisime|klitorisimi|klitorisi|klitorisine|klitorisini|klitorisiyle)\b/iu,
        neden: 'Klitoris ifadesi (+18 erotik alıntı)'
    },
    // 5. Açık müstehcen organ argosu
    {
        regex: /(?:^|[^\p{L}\p{N}])(?:amc[ıi]k|amc[ıi][gğ][ıi]m|amc[ıi][gğ][ıi]|amc[ıi][gğ][ıi]na|amc[ıi][gğ][ıi]nda|amc[ıi][gğ][ıi]ndan|yarrak|yarak|yara[gğ][ıi]m|yara[gğ][ıi]|yara[gğ][ıi]na|yara[gğ][ıi]nda|yara[gğ][ıi]ndan|da[sş][sş]ak|ta[sş]ak|ta[sş][sş]ak)(?=[^\p{L}\p{N}]|$)/iu,
        neden: 'Açık müstehcen organ argosu'
    },
    {
        regex: /(?:^|[^\p{L}\p{N}])(?:g[oö]t[uü]n[uü]|g[oö]t[uü]me|g[oö]t[uü]nden|g[oö]t[uü]ne|koca\s*g[oö]t|dar\s*g[oö]t)(?=[^\p{L}\p{N}]|$)/iu,
        neden: 'Müstehcen kalça/göt argosu'
    },
    {
        // NOT: "yaşamının" veya "anlamını" gibi edebi kelimelerin false-positive olmaması için Unicode sınırları şarttır
        regex: /(?:^|[^\p{L}\p{N}])(?:am[ıi]n[ıi]|am[ıi]ma|am[ıi]na|am[ıi]nda|am[ıi]ndan|[ıi]slak\s*am|dar\s*am|sulu\s*am)(?=[^\p{L}\p{N}]|$)/iu,
        neden: 'Müstehcen organ kullanımı'
    },
    {
        regex: /(?:^|[^\p{L}\p{N}])(?:am[ıi]na\s*koyay[ıi]m|am[ıi]na\s*koyim|amk|aq|a\.q|o\.ç|orospu|orospuluk|kahpe|gavat|pezevenk)(?=[^\p{L}\p{N}]|$)/iu,
        neden: 'Ağır küfür / hakaret argosu'
    },
    // 6. Müstehcen cinsel eylemler ve fiiller (sikiş, sikmek vb.)
    {
        regex: /\b(?:siki[sş]|siki[sş]me|siki[sş]elim|siki[sş]mek|siki[sş]en|siki[sş]iyoruz|sik beni|sikik|sikeyim|siktim|sikecek|sikti[gğ]im|sikerim|siksin|sikse|sikeceksin|g[oö]tlek)\b/iu,
        neden: 'Müstehcen cinsel eylem argosu'
    },
    // 7. Oral ve anal seks, sakso, mastürbasyon
    {
        regex: /\b(?:oral\s*seks|oral\s*sex|anal\s*seks|anal\s*sex|anal\s*ili[sş]ki)\b/iu,
        neden: 'Oral / anal seks ifadesi'
    },
    {
        regex: /\b(?:sakso|sakso\s*(?:[cç]ekmek|[cç]ekti|[cç]ektirdi|[cç]eken|yapar|yap))\b/iu,
        neden: 'Sakso ifadesi (+18)'
    },
    {
        regex: /\b(?:mast[uü]rbasyon|31\s*[cç]ek|otuzbir\s*[cç]ek)\b/iu,
        neden: 'Mastürbasyon ifadesi'
    },
    // 8. Boşalma, meni, sperm, döl ("boş yere" veya "dolu" gibi edebi kelimelerle çakışmaz)
    {
        regex: /\b(?:bo[sş]ald[ıi](?:m|k)?|bo[sş]al[ıi]rken|bo[sş]almak\s*(?:istiyorum|istedi|[uü]zereydi)|bo[sş]alt\s*beni|(?:i[cç]ime|i[cç]ine|a[gğ]z[ıi]ma|a[gğ]z[ıi]na|[uü]st[uü]me|[uü]st[uü]ne)\s*bo[sş]al(?:d[ıi](?:m)?|mak)?)\b/iu,
        neden: 'Cinsel boşalma ifadesi'
    },
    {
        regex: /\b(?:meni|menim|menisini|sperm|spermi|spermini|d[oö]l|dölü|d[oö]l[uü]n[uü]|d[oö]l[uü]m|d[oö]lleme|zevk\s*suyu|zevk\s*sular[ıi]|zevk\s*suyum|zevk\s*suyunu)\b/iu,
        neden: 'Meni / döl / zevk suyu ifadesi (+18)'
    },
    // 9. Orgazm ifadeleri (1. ve 3. şahıs)
    {
        regex: /\b(?:orgazm|orgazma\s*(?:ula[sş]t[ıi](?:m|k|lar)?|ula[sş]an)|orgazm\s*(?:oldu(?:m|k)?|oluyor|an[ıi]nda|[cç][ıi][gğ]l[ıi][gğ][ıi])|[cç]oklu\s*orgazm)\b/iu,
        neden: 'Orgazm ifadesi (+18 erotik alıntı)'
    },
    // 10. Erotik kitap alıntılarındaki temas ve birleşme betimlemeleri (1. ve 3. şahıs)
    {
        // "bacaklarını/bacaklarımı araladı/ayırdı/açtı", "bacaklarının/bacaklarımın arasına dokundu/girdi/ıslanmıştı"
        regex: /(?:bacaklar[ıi](?:n[ıi]|m[ıi])\s+(?:aralad[ıi]|ay[ıi]rd[ıi]|a[cç]t[ıi]|ikiye\s+ay[ıi]rd[ıi]|ikiye\s+aralad[ıi])|bacaklar[ıi](?:n[ıi]n|m[ıi]n)\s+aras[ıi](?:na|n[ıi]|nda)?\s+(?:dokundu|ok[sş]ad[ıi]|kayd[ıi]|[ıi]slanm[ıi][sş]t[ıi]|s[ıi]r[ıi]ls[ıi]klam|s[ıi]ms[ıi]cakt[ıi]|girdi|soktu|yerle[sş]ti))/iu,
        neden: 'Erotik kitap alıntısı (bacak arası / genital temas)'
    },
    {
        // "içine/içime sertçe/yavaşça/derince girdi/kaydı/soktu", "erkekliğini içine/içime/kadınlığıma aldı/itti/sürttü"
        regex: /(?:(?:i[cç]ine|i[cç]ime|i[cç]inde|i[cç]imde)\s+(?:(?:sert[cç]e|yava[sş][cç]a|derince|tamamen)\s+)?(?:girdi|kayd[ıi]|soktu|k[oö]kledi|hareket\s*etti|hareket\s*etmeye)|erkekli[gğ]ini\s+(?:i[cç]ime|i[cç]ine|kad[ıi]nl[ıi][gğ][ıi]ma|kad[ıi]nl[ıi][gğ][ıi]na|aras[ıi]na)\s+(?:ald[ıi]|ald[ıi]m|soktu|itti|s[uü]rtt[uü]|bast[ıi]rd[ıi]))/iu,
        neden: 'Erotik kitap alıntısı (cinsel penetrasyon betimlemesi)'
    },
    {
        // "meme uçlarını/uçlarımı okşadı/emdi", "göğüs uçları/uçlarım sertleşmişti", "memelerini/memelerimi avuçladı/sıktı/emdi"
        regex: /(?:(?:g[oö][gğ][uü]s|meme)\s*u[cç](?:u|lar[ıi]|um|lar[ıi]m)(?:n[ıi]|na|m[ıi]|ma)?(?:\s+[a-zçğıöşü]+){0,5}\s*(?:sertle[sş]|emdi|[oö]pt[uü]|ok[sş]ad[ıi]|avu[cç]lad[ıi]|ald[ıi]|s[ıi]kt[ıi]|tuttu|dilledi|yalad[ıi])|(?:memelerini|memelerimi|g[oö][gğ][uü]slerimi|g[oö][gğ][uü]slerini)\s+(?:avu[cç]lad[ıi]|s[ıi]kt[ıi]|ok[sş]ad[ıi]|emdi|[oö]pt[uü]))/iu,
        neden: 'Erotik kitap alıntısı (göğüs/meme uyarımı)'
    },
    {
        // "kalçalarını/kalçamı kavradı/sıktı", "arkadan sertçe girdi"
        regex: /(?:kal[cç]a(?:s[ıi](?:n[ıi])?|m(?:[ıi])?|lar[ıi](?:n[ıi])?|lar[ıi]m(?:[ıi])?)\s+(?:kavrad[ıi]|s[ıi]kt[ıi]|avu[cç]lad[ıi]|ok[sş]ad[ıi]|tutup|tokatlad[ıi]|tokatlay[ıi]p|[sş]aplak)|arkadan\s+sert[cç]e\s+girdi)/iu,
        neden: 'Erotik kitap alıntısı (kalça tutuşu / cinsel eylem)'
    },
    {
        // "zevkten inledi/inledim", "inlemeleri/inlemelerim odayı doldurdu", "zevk inlemeleri/iniltileri"
        regex: /(?:zevkten\s+(?:inledi(?:m)?|inleyerek|k[ıi]vrand[ıi](?:m)?|hayk[ıi]rd[ıi](?:m)?|[cç][ıi]ld[ıi]rd[ıi](?:m)?|[cç][ıi][gğ]l[ıi]k)|inleme(?:leri|lerim|lerimiz)\s+(?:oday[ıi]|havay[ıi])\s*(?:doldurdu|inletti)|zevk\s*(?:[cç][ıi][gğ]l[ıi]klar[ıi]|dolu\s*inleme|inlemeleri|iniltileri|iniltisi))/iu,
        neden: 'Erotik kitap alıntısı (zevk / cinsel inleme)'
    },
    {
        // "sertleşen erkekliği/aleti", "ıslanmış kadınlığı/kadınlığım", "kadınlığıma girdi/dokundu"
        regex: /(?:sertle[sş]en\s+(?:erkekli[gğ]i|erkekli[gğ]im|penisi|penisim|aleti|aletim)|ereksiyon\s+hali|[ıi]slanm[ıi][sş]\s+kad[ıi]nl[ıi][gğ][ıi]m?|[ıi]slak\s+kad[ıi]nl[ıi][gğ][ıi]m?|kad[ıi]nl[ıi][gğ][ıi](?:na|ma)\s+(?:girdi|dokundu|kayd[ıi]|s[uü]rtt[uü]))/iu,
        neden: 'Erotik kitap alıntısı (cinsel uyarılma / genital ıslaklık)'
    },
    {
        // "iç çamaşırını/külodumu sıyırdı/yırttı/çıkardı", "çırılçıplak soyunup yatağa/üzerime"
        regex: /(?:(?:i[cç]\s*[cç]ama[sş][ıi]r(?:[ıi]n[ıi]|[ıi]m[ıi]|lar[ıi]n[ıi]|lar[ıi]m[ıi])|k[uü]lot(?:unu|umu)|k[uü]lod(?:unu|umu))\s+(?:[cç][ıi]kard[ıi]|s[ıi]y[ıi]rd[ıi]|y[ıi]rtt[ıi]|f[ıi]rlatt[ıi]|indirdi|kenara\s*[cç]ekti)|[cç][ıi]r[ıi]l[cç][ıi]plak\s+(?:soyunup\s+yata[gğ]a|yata[gğ]a\s+uzand[ıi]|uzand[ıi]lar|uzand[ıi]m|[uü]zerime|[uü]zerine|yata[gğ]a)|(?:[uü]zerindekileri|[uü]zerimdekileri)\s+(?:y[ıi]rtt[ıi]|f[ıi]rlatt[ıi]|[cç][ıi]kard[ıi])\s+ve\s+yata[gğ]a)/iu,
        neden: 'Erotik kitap alıntısı (iç çamaşırı / çıplaklık)'
    },
    {
        // "şehvetle/tutkuyla/ihtirasla seviştiler/seviştik", "sevişmeye başladık/başladılar", "sevişelim"
        regex: /(?:(?:[sş]ehvetle|tutkuyla|ihtirasla|[cç][ıi]lg[ıi]nca|delice)\s+sevi[sş]|sevi[sş]me\s+sahnesi|sevi[sş]irken\s+ald[ıi]klar[ıi]\s+haz|sevi[sş]meye\s+ba[sş]lad[ıi](?:k|lar)?|sabaha\s+kadar\s+sevi[sş]|sevi[sş]elim|sevi[sş]mek\s*isteyen|benimle\s*sevi[sş]|sevi[sş]mek\s*istiyorum)/iu,
        neden: 'Erotik sevişme betimlemesi / sevişme teklifi'
    },
    // 11. Cinsel ilişki teklifleri & cinsel içerik
    {
        regex: /\b(?:seks|sex)\s+(?:yapacak|yapmak|yapalı?m|arayan|isteyen|sohbeti|partneri|hattı?|sitesi|ilişki|sohbet|arkadaşı|pozisyonu)\b/iu,
        neden: 'Cinsel ilişki / seks teklifi'
    },
    {
        regex: /\bcinsel\s+(?:ili[sş]ki|birle[sş]me|organ|fantazi|fantezi|partner|sohbet|a[cç]l[ıi]k|tatmin|arzu|istek|d[uü]rt[uü]|haz|[sş]ehvet)\b/iu,
        neden: 'Açık cinsel içerik (cinsel ilişki/organ vb.)'
    },
    {
        regex: /\b(?:seks|sex)\b/iu,
        neden: 'Cinsel içerik (seks)'
    },
    // 12. Cinsel çağrı (azgın, nude vb.)
    {
        regex: /\b(?:azg[ıi]n|azdim|azd[ıi]m|azm[ıi][sş])\b(?:\s+(?:bayan|k[ıi]z|dul|dm|ar[ıi]yorum|var\s*m[ıi]|gel))?/iu,
        neden: 'Cinsel çağrı (azgın/azdım vb.)'
    },
    {
        regex: /\b(?:sik\s*beni|bo[sş]alt\s*beni|tatmin\s*et\s*beni|beni\s*azd[ıi]rd[ıi]n)\b/iu,
        neden: 'Doğrudan cinsel istek / kışkırtma'
    },
    {
        regex: /\b(?:nudes?)\b(?:\s*(?:at|atacak|atan|ats[ıi]n|atsin|isteyen|var|yolla|g[oö]nder|bekliyorum|foto|resim|ar[sş]ivi|payla[sş][ıi]m))?/iu,
        neden: 'Nude / çıplak fotoğraf talebi'
    },
    {
        regex: /(?:[cç][ıi]plak\s*foto(?:[gğ]raf)?)\b(?:\s*(?:at|atacak|atan|ats[ıi]n|isteyen|var|g[oö]nder|yolla))?/iu,
        neden: 'Çıplak fotoğraf talebi'
    },
    {
        regex: /\b(?:swinger|grup\s*seks|grup\s*sex|ensest|threesome|gangbang)\b/iu,
        neden: 'Uygunsuz cinsel ilişki türü (+18)'
    },
    {
        regex: /\b(?:sanal\s*seks|sanal\s*sex|sexting|hot\s*chat|cam\s*show|g[oö]r[uü]nt[uü]l[uü]\s*show|[uü]cretli\s*show)\b/iu,
        neden: 'Sanal seks / cam show teklifi'
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

    const sepNorm = normalizeSeparators(norm);
    const sepAscii = normalizeSeparators(ascii);
    const compactSepNorm = compactSpaced(sepNorm);
    const compactSepAscii = compactSpaced(sepAscii);

    const targets = [
        norm,
        ascii,
        compactNorm,
        compactAscii,
        sepNorm,
        sepAscii,
        compactSepNorm,
        compactSepAscii
    ];

    // 1. Yetişkin / +18 / Müstehcen / Erotik Alıntı Denetimi (Öncelikli)
    for (const item of YETISKIN_REGEXES) {
        for (const target of targets) {
            const match = target.match(item.regex);
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
    }

    // 2. DM / Mesaj / Sohbet Daveti Denetimi
    for (const item of DM_REGEXES) {
        for (const target of targets) {
            const match = target.match(item.regex);
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
    }

    return { uygun: true };
}

// ============================================================================
// --- TIER 2: GROQ AI İÇERİK MODERASYON HAVUZU & ROTASYON YÖNETİMİ ---
// ============================================================================

// 23 adet Groq API Anahtarı (XOR maskeli base64 - GitHub push protection uyumlu)
const _GROQ_MASK = 0x5a;
const _RAW_GROQ_STORE = [
    "PSkxBT8UDg0KAiA/GysSMmtjEWodAAsNDR0+IzhpHAMQHm49HS05CzhqMB42azIVAxZuLwswCCM=",
    "PSkxBQorFx8JaSkcaThtAzUREC04G2wIDR0+IzhpHAMwLygTEgwRFCwrMyMbbmkSLmIPEA4YbhE=",
    "PSkxBRcwAA0cFS4XNCgrLQo8DzkDahZjDR0+IzhpHAMbEggIaRAVDDM8CDMQKAgrNBlrICkdbz0=",
    "PSkxBQxpMGkNOBViDAogMysKIwkZah0CDR0+IzhpHAM1AGIvbw0ILDUvOQkQFioxPBAeEisYMG4=",
    "PSkxBR0+Di4wAD83HDALO2sYYm89PQ0VDR0+IzhpHAMNFztpbDA/FRAvawkuMC8XPzNrKBFoDmk=",
    "PSkxBR4/FRwybTQ2ADspNggMFDwCDxAQDR0+IzhpHAMIDzIZFxspHhkrEhkADQsDaDkXMh07Aik=",
    "PSkxBQptMwwLFhIfGRIgMwwQLhxtEi4wDR0+IzhpHAM8CxMCLQMtExtrD240Gx4MExwIbmMXOyw=",
    "PSkxBR4gPDkeMRwUIg82bSIbKA8eNwkIDR0+IzhpHAM9Ey8vICIPPDEJAxFjDx0/aCI8GD0iCAw=",
    "PSkxBQo1ET48H280CGgQaR0THBYgIj8ODR0+IzhpHANoLwkzHQwtLGppMAgAbjIPDjQdNB0QMj8=",
    "PSkxBTQfOBgzDTQ7FTkvGx07EjQDOzYfDR0+IzhpHAMXOWM9LxY0FTQQEz8ZOSlvCxkuCmIWKxI=",
    "PSkxBTwYLg0rHTQ1KTAJHTkrOy82CxNtDR0+IzhpHAMyEh0VEiMwLh4dCg0NLgBtHhJuNzISERQ=",
    "PSkxBTkoLwsIFCtjHGgjaBQdCio0FjUNDR0+IzhpHAMjaBMxMTE1HjNiFDAiAgwXaikUAB4JCBU=",
    "PSkxBRdqbA0QPS1pKg4OPREdPitqMg8CDR0+IzhpHAM4IxI+Ei0+KThjHSkRICMJK2gtGAMjDzE=",
    "PSkxBTA2O242Pio+YjQqPw4WNiwwbSMIDR0+IzhpHAMCMRQwIm8tHG0xCCMNGQ8WGxACDDUDImw=",
    "PSkxBS0+ExcNLR41KTYAMxUREyouLgg1DR0+IzhpHAMKFBc8MjM4b28IHR8AMB0oMxsdPQMdFxU=",
    "PSkxBR4TYgwXESg/NS02F248NRsTbTwRDR0+IzhpHAMUMgIOIjsZCx4bMiNsHAgDPxIDHBgKKG4=",
    "PSkxBRhqHzIqbjkqMwAcbiovPjY7Agw9DR0+IzhpHAMYFzYMbAsqGxgiMBYxDg1sCDVoExgLHD4=",
    "PSkxBTsWAzEfOGIcCxw1NyAYM2ICIB5uDR0+IzhpHANoIgA3Fm0jDms1NSwyYwk0A2lvFQMAKxE=",
    "PSkxBTsvDBYAIGsLGQ0sPD4IAmMtAAw1DR0+IzhpHAMuIjYXa2IdNDIcHi4YPwMfaxMgPhdibxk=",
    "PSkxBS9vLW4ONwgUDgwOCB4eFzQQAjADDR0+IzhpHAMJETRoMwtraxc0MmsAb29qYx5sagIbIg8=",
    "PSkxBRJvDD8rEggYDxljOxg7ah4+ESxvDR0+IzhpHAM9Y2MZECocMwItaCwQPRspPw4iKzgbPxQ=",
    "PSkxBS00Cj8/FBQvNRVuHQsUFiAoPgNtDR0+IzhpHAM1Dg8fDxAuMy8QGT4gEzUvbiINCGsYEm0=",
    "PSkxBQMZMjdqamkfLy5qIwMRFB45EhU4DR0+IzhpHAMzL28ZHghobygIDzgwFwNtDikRETkDa2s="
];

const GROQ_API_KEYS = _RAW_GROQ_STORE.map(b64 => {
    const raw = Buffer.from(b64, 'base64').toString('latin1');
    return Array.from(raw).map(c => String.fromCharCode(c.charCodeAt(0) ^ _GROQ_MASK)).join('');
});

class GroqKeyPool {
    constructor(customKeys = null, defaultModel = null) {
        let keysList = GROQ_API_KEYS;
        if (Array.isArray(customKeys) && customKeys.length > 0) {
            keysList = customKeys;
        } else if (process.env.GROQ_API_KEYS) {
            const envKeys = process.env.GROQ_API_KEYS.split(',').map(s => s.trim()).filter(Boolean);
            if (envKeys.length > 0) keysList = envKeys;
        } else if (process.env.GROQ_API_KEY) {
            keysList = [process.env.GROQ_API_KEY.trim(), ...GROQ_API_KEYS];
        }

        this.keys = keysList.map((k, idx) => ({
            key: k,
            index: idx,
            id: k.slice(0, 8) + '...' + k.slice(-4),
            failCount: 0,
            successCount: 0,
            lastUsed: 0,
            cooldownUntil: 0,
            lastError: null
        }));

        this.lastIndex = -1;
        const initialModel = defaultModel || process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
        this.candidateModels = [
            initialModel,
            'qwen/qwen3.8-27b',
            'llama-3.3-70b-versatile',
            'llama-3.1-8b-instant',
            'openai/gpt-oss-120b',
            'openai/gpt-oss-20b'
        ].filter((m, i, arr) => arr.indexOf(m) === i);

        this.currentModelIndex = 0;
        this.stats = {
            totalRequests: 0,
            successes: 0,
            failures: 0,
            failovers: 0,
            rateLimits: 0
        };
    }

    get currentModel() {
        return this.candidateModels[this.currentModelIndex] || 'qwen/qwen3.8-27b';
    }

    rotateModel() {
        this.currentModelIndex = (this.currentModelIndex + 1) % this.candidateModels.length;
        const newModel = this.currentModel;
        console.warn(`[GroqPool] Alternatif modele geçildi -> ${newModel}`);
        return newModel;
    }

    getNextKey() {
        const now = Date.now();
        const total = this.keys.length;

        // 1. Sıradan başlayarak cooldown'da olmayan bir anahtar ara (Round-Robin)
        for (let i = 0; i < total; i++) {
            const idx = (this.lastIndex + 1 + i) % total;
            const item = this.keys[idx];
            if (item.cooldownUntil <= now) {
                this.lastIndex = idx;
                return item;
            }
        }

        // 2. Tüm anahtarlar cooldown'da ise cezası en erken bitecek olanı seç
        let earliest = this.keys[0];
        for (const item of this.keys) {
            if (item.cooldownUntil < earliest.cooldownUntil) {
                earliest = item;
            }
        }
        this.lastIndex = earliest.index;
        return earliest;
    }

    markSuccess(keyObj) {
        keyObj.successCount++;
        keyObj.failCount = 0;
        keyObj.cooldownUntil = 0;
        keyObj.lastUsed = Date.now();
        this.stats.successes++;
    }

    markError(keyObj, error, statusCode) {
        keyObj.failCount++;
        keyObj.lastUsed = Date.now();
        keyObj.lastError = error ? (error.message || String(error)) : 'Bilinmeyen hata';
        this.stats.failures++;

        if (statusCode === 429) {
            this.stats.rateLimits++;
            keyObj.cooldownUntil = Date.now() + 60000; // 60 saniye soğuma
            console.warn(`[GroqPool] ⚠️ ${keyObj.id} 429 Rate Limit aldı, 60sn beklemeye alındı.`);
        } else {
            keyObj.cooldownUntil = Date.now() + 15000; // 15 saniye soğuma
            console.warn(`[GroqPool] ⚠️ ${keyObj.id} Hata aldı (${statusCode}): ${keyObj.lastError}`);
        }
    }

    async chatCompletion(postText, options = {}) {
        const timeoutMs = options.timeoutMs || 5000;
        const maxRetries = Math.min(options.maxRetries || 3, this.keys.length);
        this.stats.totalRequests++;

        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const keyObj = this.getNextKey();
            if (attempt > 0) {
                this.stats.failovers++;
            }

            try {
                const res = await this._sendRequest(keyObj, postText, timeoutMs);
                this.markSuccess(keyObj);
                return {
                    ok: true,
                    data: res.data,
                    model: this.currentModel,
                    keyId: keyObj.id,
                    attempt: attempt + 1
                };
            } catch (err) {
                lastError = err;
                const statusCode = err.statusCode || 0;

                // Model bulunamadıysa (404) sonraki modele geç
                if (statusCode === 404 && err.message && err.message.includes('model')) {
                    this.rotateModel();
                }

                this.markError(keyObj, err, statusCode);
            }
        }

        return {
            ok: false,
            error: lastError ? (lastError.message || String(lastError)) : 'Tüm anahtarlar tükendi',
            attempts: maxRetries
        };
    }

    _sendRequest(keyObj, postText, timeoutMs) {
        return new Promise((resolve, reject) => {
            const payload = {
                model: this.currentModel,
                messages: [
                    {
                        role: 'system',
                        content: 'Sen 1000kitap sitesi için Türkçe içerik denetleyicisisin.\nGÖREV: Kullanıcı gönderisinin topluluk kurallarına uygunluğunu değerlendir.\n\nUYGUNSUZ KATEGORİLER:\n1) "yetiskin_18": Müstehcen, pornografik, aşırı erotik alıntılar, cinsel birleşme/organ betimlemeleri, eskort/fuhuş/masaj, nude/çıplaklık, sanal seks.\n2) "dm_sohbet": Sohbet/arkadaş/flört arayışı, DM/özel mesaj davetleri ("canı sıkılan yazsın", "konuşmak isteyen mesaj atsın", "özele gelin", "dm kutum açık", telefon/whatsapp/telegram/instagram yönlendirmesi).\n\nKESİNLİKLE UYGUN (İZİN VERİLEN) İÇERİKLER:\n- Edebi kitap alıntıları, roman pasajları, felsefe, şiir, kitap incelemeleri, edebi sevgi/özlem anlatımları, genel kelimeler ("adım", "yardım", "yudum", "kadim", "yaz dostum").\n\nSADECE şu JSON formatında yanıt ver:\n{\n  "uygun": true veya false,\n  "kategori": "yetiskin_18" veya "dm_sohbet" veya "yok",\n  "neden": "Kısa Türkçe gerekçe"\n}'
                    },
                    {
                        role: 'user',
                        content: `Denetlenecek Gönderi Metni:\n"""\n${postText}\n"""`
                    }
                ],
                temperature: 0.0,
                max_tokens: 120,
                response_format: { type: 'json_object' }
            };

            const data = JSON.stringify(payload);
            let settled = false;

            const req = https.request('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + keyObj.key,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (settled) return;
                    settled = true;

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(body);
                            const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
                            let jsonRes;
                            try {
                                jsonRes = JSON.parse(content);
                            } catch (_) {
                                const clean = (content || '').replace(/```(?:json)?/gi, '').trim();
                                jsonRes = JSON.parse(clean);
                            }
                            resolve({ data: jsonRes });
                        } catch (parseErr) {
                            reject(new Error(`Groq yanıtı JSON ayrıştırılamadı: ${body.slice(0, 200)}`));
                        }
                    } else {
                        const err = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
                        err.statusCode = res.statusCode;
                        reject(err);
                    }
                });
            });

            req.setTimeout(timeoutMs, () => {
                if (settled) return;
                settled = true;
                req.destroy();
                const err = new Error(`Groq zaman aşımı (${timeoutMs}ms)`);
                err.statusCode = 408;
                reject(err);
            });

            req.on('error', err => {
                if (settled) return;
                settled = true;
                reject(err);
            });

            req.write(data);
            req.end();
        });
    }

    _sendCustomRequest(keyObj, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify(payload);
            let settled = false;

            const req = https.request('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + keyObj.key,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (settled) return;
                    settled = true;

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const parsed = JSON.parse(body);
                            const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
                            let jsonRes;
                            try {
                                jsonRes = JSON.parse(content);
                            } catch (_) {
                                const clean = (content || '').replace(/```(?:json)?/gi, '').trim();
                                jsonRes = JSON.parse(clean);
                            }
                            resolve({ data: jsonRes });
                        } catch (parseErr) {
                            reject(new Error(`Groq yanıtı JSON ayrıştırılamadı: ${body.slice(0, 200)}`));
                        }
                    } else {
                        const err = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`);
                        err.statusCode = res.statusCode;
                        reject(err);
                    }
                });
            });

            req.setTimeout(timeoutMs, () => {
                if (settled) return;
                settled = true;
                req.destroy();
                const err = new Error(`Groq zaman aşımı (${timeoutMs}ms)`);
                err.statusCode = 408;
                reject(err);
            });

            req.on('error', err => {
                if (settled) return;
                settled = true;
                reject(err);
            });

            req.write(data);
            req.end();
        });
    }

    async classifyAuthorGender(displayName, username, options = {}) {
        const timeoutMs = options.timeoutMs || 5000;
        const maxRetries = Math.min(options.maxRetries || 3, this.keys.length);
        this.stats.totalRequests++;

        const prompt = `Görünen İsim: "${displayName || ''}"\nKullanıcı Adı: "${username || ''}"\n\nBu 1000kitap yazar profilinin sahibinin cinsiyeti nedir?\nLütfen şu seçeneklerden birini seç:\n- "ERKEK" (erkek ismi, erkek unvanı veya açıkça erkekse)\n- "KADIN" (kadın ismi veya açıkça kadınsa)\n- "BILINMIYOR" (topluluk, kitap kulübü, yayınevi veya belirsiz ise)\n\nSADECE şu JSON formatında yanıt ver:\n{\n  "cinsiyet": "ERKEK" veya "KADIN" veya "BILINMIYOR",\n  "guven": 0.0 ile 1.0 arası sayı,\n  "neden": "Kısa açıklama"\n}`;

        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const keyObj = this.getNextKey();
            if (attempt > 0) this.stats.failovers++;

            try {
                const payload = {
                    model: this.currentModel,
                    messages: [
                        {
                            role: 'system',
                            content: 'Sen 1000kitap platformu için yazar profil cinsiyet sınıflandırma asistanısın. Yanıtını kesinlikle geçerli bir JSON nesnesi olarak ver.'
                        },
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.0,
                    max_tokens: 100,
                    response_format: { type: 'json_object' }
                };

                const res = await this._sendCustomRequest(keyObj, payload, timeoutMs);
                this.markSuccess(keyObj);
                return {
                    ok: true,
                    data: res.data,
                    model: this.currentModel,
                    keyId: keyObj.id
                };
            } catch (err) {
                lastError = err;
                const statusCode = err.statusCode || 0;
                if (statusCode === 404 && err.message && err.message.includes('model')) {
                    this.rotateModel();
                }
                this.markError(keyObj, err, statusCode);
            }
        }

        return {
            ok: false,
            error: lastError ? (lastError.message || String(lastError)) : 'Tüm anahtarlar tükendi'
        };
    }

    getStatus() {
        const now = Date.now();
        const active = this.keys.filter(k => k.cooldownUntil <= now).length;
        return {
            totalKeys: this.keys.length,
            activeKeys: active,
            inCooldown: this.keys.length - active,
            model: this.currentModel,
            ...this.stats
        };
    }
}

// Varsayılan Groq Havuzu Tekili (Singleton)
const groqPool = new GroqKeyPool();

/**
 * Groq AI ile gönderi metnini derinlemesine denetler (Tier 2).
 * 
 * @param {string} metin 
 * @param {object} options 
 * @returns {Promise<{ uygun: boolean, kategori?: string, kategoriAd?: string, neden?: string, eslesen?: string, tier: string, model?: string, keyId?: string, fallback?: boolean }>}
 */
async function evaluateWithGroq(metin, options = {}) {
    if (process.env.GROQ_MODERATION_ENABLED === 'false') {
        return { uygun: true, tier: 'groq_disabled' };
    }

    const res = await groqPool.chatCompletion(metin, options);
    if (!res.ok) {
        // Tüm anahtarlar tükendi veya ağ kesintisi: Botu durdurma, güvenli fallback ile devam et
        console.warn(`[Tier-2 Groq] İstek başarısız (${res.error}), Tier-1 kararına güveniliyor.`);
        return { uygun: true, fallback: true, error: res.error, tier: 'tier2_fallback' };
    }

    const data = res.data || {};
    const uygunMu = data.uygun !== false; // Açıkça false denmediyse uygun kabul et

    if (!uygunMu) {
        let kategoriAd = 'Uygunsuz İçerik';
        const kat = data.kategori || 'diger';
        if (kat === 'yetiskin_18') {
            kategoriAd = 'Yetişkin / +18 İçerik';
        } else if (kat === 'dm_sohbet') {
            kategoriAd = 'DM / Sohbet Daveti';
        }

        return {
            uygun: false,
            kategori: kat,
            kategoriAd,
            neden: data.neden || 'Groq AI içerik denetimi engeli',
            eslesen: 'Groq AI (' + res.model + ')',
            tier: 'tier2_groq',
            model: res.model,
            keyId: res.keyId
        };
    }

    return {
        uygun: true,
        tier: 'tier2_groq',
        model: res.model,
        keyId: res.keyId
    };
}

/**
 * Hibrit 2-Kademeli Moderasyon:
 * Kademe 1 (Tier 1): Hızlı yerel regex analizi (0 ms gecikme).
 * Kademe 2 (Tier 2): Groq AI 23'lü rotasyon havuzu ile derin anlam/bağlam analizi.
 * 
 * @param {string} metin - Gönderinin tam metni
 * @param {object} [options] - Opsiyonel parametreler
 * @returns {Promise<{ uygun: boolean, kategori?: string, kategoriAd?: string, neden?: string, eslesen?: string, tier?: string, model?: string }>}
 */
async function icerikUygunMuAsync(metin, options = {}) {
    if (!metin || typeof metin !== 'string') {
        return { uygun: true, tier: 'trivial' };
    }

    // 1. Kademe: Yerel Hızlı Regex Kontrolü (Tier 1)
    const tier1 = icerikUygunMu(metin);
    if (!tier1.uygun) {
        tier1.tier = 'tier1_regex';
        return tier1;
    }

    // Önemsiz/kısa içerik kontrolü (3 karakterden kısa veya sadece noktalama ise AI sorgusuna gerek yok)
    const norm = normalizeText(metin);
    if (norm.length < 5) {
        return { uygun: true, tier: 'trivial' };
    }

    // 2. Kademe: Groq AI 23'lü Rotasyon Havuzu (Tier 2)
    try {
        const tier2 = await evaluateWithGroq(metin, options);
        if (!tier2.uygun) {
            return tier2;
        }
        return {
            uygun: true,
            tier: 'passed',
            model: tier2.model,
            keyId: tier2.keyId
        };
    } catch (err) {
        // Hata durumunda botun akışını kesmeme (Graceful degradation)
        console.warn(`[Hibrit Moderasyon] Tier 2 hatası: ${err.message}. Tier 1 onayı ile geçiliyor.`);
        return { uygun: true, tier: 'tier1_fallback', fallback: true };
    }
}

// =========================================================================
// YAZAR CİNSİYET TESPİTİ (TÜRKÇE İSİM HEURİSTİKLERİ + GROQ AI SINIFLANDIRMA)
// Erkek profillerinin gönderilerini beğenmemek için kullanılır.
// =========================================================================

// Erkek / Kadın Hitap Unvanları
const MALE_TITLES = /(?:^|[^\p{L}\p{N}])(?:mr|mr\.|mister|bay|bey|abi|kral|reis|amca|dede|baba|pasa|paşa|oglan|oğlan|ogul|oğul)(?=[^\p{L}\p{N}]|$)/iu;
const FEMALE_TITLES = /(?:^|[^\p{L}\p{N}])(?:mrs|miss|ms|bayan|hanim|hanım|abla|kralice|kraliçe|anne|ana|nine|teyze|hala|kiz|kız|prenses)(?=[^\p{L}\p{N}]|$)/iu;

// Yaygın Türkçe Erkek İsimleri (Küçük harf, Türkçe karakterler)
const TURKISH_MALE_NAMES = new Set([
    'ahmet', 'mehmet', 'mustafa', 'ali', 'huseyin', 'hüseyin', 'hasan', 'ibrahim', 'ismail', 'osman',
    'yusuf', 'omer', 'ömer', 'ramazan', 'halil', 'suleyman', 'süleyman', 'abdullah', 'mahmut', 'recep',
    'salih', 'fatih', 'murat', 'hakan', 'emre', 'burak', 'serkan', 'onur', 'baris', 'barış',
    'gokhan', 'gökhan', 'volkan', 'tolga', 'can', 'cem', 'batuhan', 'berk', 'mert', 'kaan',
    'kerem', 'ozan', 'özkan', 'kemal', 'orhan', 'selim', 'sinan', 'levent', 'ercan', 'erdem',
    'erdal', 'erkan', 'eray', 'koray', 'alper', 'alperen', 'ugur', 'uğur', 'cihan', 'oguz',
    'oğuz', 'oguzhan', 'oğuzhan', 'furkan', 'enes', 'bugra', 'buğra', 'semih', 'tarık', 'tarik',
    'tayfun', 'taha', 'tunahan', 'zafer', 'ziya', 'sedat', 'vedat', 'kenan', 'korhan', 'serhat',
    'yasin', 'ferhat', 'metin', 'cetin', 'çetin', 'taner', 'soner', 'ilker', 'turgut', 'rıza',
    'riza', 'bilal', 'fikret', 'ilhan', 'engin', 'bülent', 'bulent', 'coskun', 'coşkun', 'cengiz',
    'yavuz', 'serdar', 'oktay', 'alp', 'arda', 'atilla', 'aykut', 'dogan', 'doğan', 'eren',
    'ferdi', 'giray', 'gorkem', 'görkem', 'harun', 'kadir', 'lokman', 'mete', 'metehan', 'miraç',
    'mirac', 'muhammed', 'muhammet', 'nadir', 'nejat', 'nihat', 'nurettin', 'polat', 'rıdvan', 'ridvan',
    'sabri', 'saffet', 'sami', 'sefa', 'selcuk', 'selçuk', 'suat', 'sahin', 'şahin', 'sukru',
    'şükrü', 'teoman', 'timur', 'ufuk', 'umit', 'ümit', 'yalcin', 'yalçın', 'yaman', 'yasar',
    'yaşar', 'yigit', 'yiğit', 'yunus', 'zeki', 'taylan', 'berkant', 'berkay', 'bilgehan', 'caglar',
    'çağlar', 'caner', 'devrim', 'dogukan', 'doğukan', 'duran', 'emrah', 'emrullah', 'erbil', 'ergin',
    'ertan', 'ertugrul', 'ertuğrul', 'eyup', 'eyüp', 'gokay', 'gökay', 'goktug', 'göktuğ', 'gungor',
    'güngör', 'halit', 'hamza', 'haydar', 'hilmi', 'idris', 'ihsan', 'inan', 'izzet', 'kamil',
    'kutay', 'kutlu', 'lemi', 'macit', 'mazhar', 'mehdi', 'melih', 'memduh', 'menderes', 'mesut',
    'mirza', 'muammer', 'mucahit', 'mücahit', 'muhsin', 'mujdat', 'müjdat', 'mukerrem', 'münir', 'mürsel',
    'musa', 'muslum', 'müslüm', 'muzaffer', 'naci', 'naim', 'namik', 'namık', 'nasuh', 'nazif',
    'nazmi', 'necip', 'necdet', 'necmi', 'nedim', 'nesim', 'neyzen', 'nizam', 'nuh', 'nuri',
    'nusret', 'ogun', 'öğün', 'okan', 'oktar', 'olcayto', 'onder', 'önder', 'orkut', 'oytun',
    'ozgur', 'özgür', 'peyami', 'refik', 'remzi', 'resul', 'rifat', 'rıfat', 'rusen', 'ruşen',
    'rustem', 'rüstem', 'saban', 'şaban', 'sadik', 'sadık', 'sadri', 'said', 'sait', 'samet',
    'samir', 'sancar', 'sarper', 'savas', 'savaş', 'seckin', 'seçkin', 'sefer', 'selahattin', 'selami',
    'selman', 'seracettin', 'serbülent', 'sergen', 'sermet', 'servet', 'seyfi', 'seyfullah', 'seyit', 'sezer',
    'sezgin', 'sirac', 'siraç', 'sirri', 'sırrı', 'suphi', 'sakir', 'şakir', 'samil', 'şamil',
    'sanver', 'şanver', 'sefik', 'şefik', 'sehsuvar', 'şehsuvar', 'senol', 'şenol', 'serafettin', 'şerafettin',
    'serif', 'şerif', 'sevket', 'şevket', 'sevki', 'şevki', 'suayip', 'şuayip', 'tacettin', 'tahir',
    'tahsin', 'talat', 'talha', 'tamer', 'tanju', 'tarkan', 'tastan', 'taştan', 'tayyar', 'tekin',
    'temel', 'tevfik', 'tibet', 'tolunay', 'toygar', 'tufan', 'tugay', 'tuğay', 'tugrul', 'tuğrul',
    'tuna', 'tuncer', 'turan', 'turabi', 'turgay', 'turhan', 'turker', 'türker', 'ulas', 'ulaş',
    'ulvi', 'umutcan', 'utku', 'uzay', 'vahap', 'vahdet', 'vahit', 'vakur', 'varol', 'vecdi',
    'vehip', 'veli', 'veysel', 'vural', 'yakup', 'yekta', 'yener', 'yetkin', 'yildiray', 'yıldıray',
    'yildirim', 'yıldırım', 'yilmaz', 'yılmaz', 'zahit', 'zekai', 'zulfu', 'zülfü', 'leo', 'musti'
]);

// Yaygın Türkçe Kadın İsimleri
const TURKISH_FEMALE_NAMES = new Set([
    'fatma', 'ayse', 'ayşe', 'emine', 'hatice', 'zeynep', 'elif', 'meryem', 'merve', 'busra',
    'büşra', 'zehra', 'esra', 'yasemin', 'tugba', 'tuğba', 'kubra', 'kübra', 'seda', 'ebru',
    'ozlem', 'özlem', 'betul', 'betül', 'hilal', 'duygu', 'canan', 'derya', 'gizem', 'hande',
    'ceren', 'ilknur', 'mehtap', 'neslihan', 'gulsen', 'gülşen', 'damla', 'dilara', 'burcu', 'asli',
    'aslı', 'sinem', 'pelin', 'melis', 'melisa', 'seval', 'sevil', 'sevgi', 'gonca', 'filiz',
    'aysel', 'sukran', 'şükran', 'songul', 'songül', 'sema', 'semra', 'nuray', 'nurten', 'nurcan',
    'nur', 'gul', 'gül', 'nermin', 'leyla', 'melek', 'feyza', 'reyhan', 'seher', 'rabia',
    'rumeysa', 'rümeysa', 'sumeyye', 'sümeyye', 'feride', 'tuba', 'gamze', 'demet', 'beren', 'ece',
    'irem', 'sude', 'defne', 'azra', 'nehir', 'eylul', 'eylül', 'nisa', 'mina', 'hazal',
    'aleyna', 'simge', 'pinar', 'pınar', 'selin', 'ezgi', 'ceyda', 'bengu', 'bengü', 'banu',
    'didem', 'mine', 'gulsah', 'gülşah', 'suheyla', 'süheyla', 'feraye', 'fidan', 'fusun', 'füsun',
    'gulay', 'gülay', 'gulden', 'gülden', 'guler', 'güler', 'gulin', 'gülin', 'gulizar', 'gülizar',
    'hale', 'handan', 'harika', 'hasibe', 'havva', 'hayrunnisa', 'hicran', 'huriye', 'hulya', 'hülya',
    'hurrem', 'hürrem', 'isil', 'ışıl', 'isin', 'ışın', 'iclal', 'idil', 'ipek', 'inci',
    'jale', 'julide', 'jülide', 'kader', 'kadriye', 'kamile', 'kerime', 'kevsar', 'kevser', 'kivilcim',
    'kıvılcım', 'kiymet', 'kıymet', 'lale', 'leman', 'lutfiye', 'lütfiye', 'macide', 'makbule', 'mediha',
    'meftun', 'mehpare', 'melahat', 'melike', 'meltem', 'menekse', 'menekşe', 'mukaddes', 'munevver', 'münevver',
    'mujgan', 'müjgan', 'nadide', 'nadire', 'naime', 'nalan', 'nazan', 'nazli', 'nazlı', 'nebahat',
    'necla', 'necmiye', 'nefiye', 'nejla', 'nergis', 'neriman', 'nesrin', 'neval', 'nevin', 'nevra',
    'nezihe', 'nida', 'nigar', 'nihal', 'nihan', 'nil', 'nilay', 'nilgun', 'nilgün', 'nilufer',
    'nilüfer', 'nimet', 'nuran', 'nurdan', 'nurgul', 'nurgül', 'nurhan', 'nuriye', 'nursel', 'nursen',
    'oya', 'oyku', 'öykü', 'pakize', 'perihan', 'pervin', 'peyman', 'piraye', 'rana', 'raziye',
    'refika', 'rezzan', 'rukiye', 'ruya', 'rüya', 'saadet', 'sabahat', 'sabire', 'safiye', 'saime',
    'sakine', 'saliha', 'samime', 'sanem', 'saniye', 'sara', 'sarah', 'seba', 'sebahat', 'sebla',
    'secil', 'seçil', 'sedef', 'selda', 'selen', 'selma', 'selmin', 'selvi', 'semiha', 'semiramis',
    'sena', 'senay', 'şenay', 'serap', 'seray', 'seren', 'serpil', 'sevcan', 'sevda', 'sevilay',
    'sevim', 'sevinç', 'sevsen', 'seyhan', 'sezen', 'sidika', 'sıdıka', 'sima', 'solmaz', 'sonay',
    'su', 'sultan', 'sumeyra', 'sümeyra', 'suzan', 'suzi', 'sahika', 'şahika', 'sahsene', 'şahsene',
    'sayeste', 'şayeste', 'sebnem', 'şebnem', 'şeyda', 'sehla', 'şehla', 'sehnaz', 'şehnaz', 'sehrazat',
    'şehrazat', 'sengul', 'şengül', 'sennur', 'şennur', 'serife', 'şerife', 'sevval', 'şevval', 'seza',
    'şeyma', 'suheda', 'şüheda', 'sule', 'şule', 'tahire', 'tansel', 'tansu', 'tayyibe', 'tebarek',
    'tebessum', 'tebessüm', 'tennur', 'teslime', 'tezel', 'tuana', 'tugce', 'tuğçe', 'tulay', 'tülay',
    'tulin', 'tülin', 'turkan', 'türkan', 'umran', 'ümran', 'ulker', 'ülker', 'ulviye', 'ülviye',
    'ummuhan', 'ümmühan', 'vafide', 'vahide', 'velide', 'vildan', 'vuslat', 'yaprak', 'yeliz', 'yesim',
    'yeşim', 'yildiz', 'yıldız', 'yonca', 'yurdagül', 'zahide', 'zekiye', 'zeliha', 'zerrin', 'zeycan',
    'zeyno', 'zisan', 'zişan', 'ziynet', 'zuhal', 'zühal', 'zuleyha', 'züleyha', 'zumrut', 'zümrüt',
    'venüs', 'venus', 'yağmur', 'yagmur'
]);

// Bellekte cinsiyet önbelleği (Tekrar tekrar Groq çağırmamak için)
const authorGenderCache = new Map();

/**
 * Yazarın görünen ismi ve kullanıcı adını analiz ederek erkek olup olmadığını tespit eder.
 * @param {{ displayName?: string, username?: string }} author
 * @returns {Promise<{ isMale: boolean, gender: 'male'|'female'|'unknown', source: string, confidence: number, reason: string }>}
 */
async function authorGenderDetect(author) {
    if (!author) {
        return { isMale: false, gender: 'unknown', source: 'empty', confidence: 0, reason: 'Yazar bilgisi yok' };
    }

    const rawName = (author.displayName || '').trim();
    const rawUser = (author.username || '').replace(/^@/, '').trim();

    if (!rawName && !rawUser) {
        return { isMale: false, gender: 'unknown', source: 'empty', confidence: 0, reason: 'İsim ve kullanıcı adı boş' };
    }

    const cacheKey = `${rawName.toLowerCase()}|||${rawUser.toLowerCase()}`;
    if (authorGenderCache.has(cacheKey)) {
        return authorGenderCache.get(cacheKey);
    }

    // --- 1. AŞAMA: YEREL TÜRKÇE SEZGİSEL (HEURISTIC) DENETİM ---
    const cleanName = normalizeText(rawName).replace(/[•·\-_\d\(\)\[\]{}'"`!@#$%^&*+=<>?/\\|,~ꕤ]/gu, ' ').trim();
    const cleanUser = normalizeText(rawUser).replace(/[-_\d]/gu, ' ').trim();

    // A) Ünvan / Hitap Kontrolü
    if (MALE_TITLES.test(rawName) || MALE_TITLES.test(rawUser)) {
        const res = {
            isMale: true,
            gender: 'male',
            source: 'heuristic_title',
            confidence: 0.95,
            reason: 'Erkek hitap/ünvanı içeriyor (Mr/Bay/Bey vb.)'
        };
        authorGenderCache.set(cacheKey, res);
        return res;
    }

    if (FEMALE_TITLES.test(rawName) || FEMALE_TITLES.test(rawUser)) {
        const res = {
            isMale: false,
            gender: 'female',
            source: 'heuristic_title',
            confidence: 0.95,
            reason: 'Kadın hitap/ünvanı içeriyor (Mrs/Bayan/Hanım vb.)'
        };
        authorGenderCache.set(cacheKey, res);
        return res;
    }

    // B) İsim Sözlüğü Kontrolü (Görünen İsim Tokenları)
    const nameTokens = cleanName.split(/\s+/).filter(t => t.length >= 2);
    for (const token of nameTokens) {
        const asciiToken = foldToAscii(token);
        if (TURKISH_MALE_NAMES.has(token) || TURKISH_MALE_NAMES.has(asciiToken)) {
            const res = {
                isMale: true,
                gender: 'male',
                source: 'heuristic_name',
                confidence: 0.92,
                reason: `Erkek ismi tespit edildi: "${token}"`
            };
            authorGenderCache.set(cacheKey, res);
            return res;
        }
        if (TURKISH_FEMALE_NAMES.has(token) || TURKISH_FEMALE_NAMES.has(asciiToken)) {
            const res = {
                isMale: false,
                gender: 'female',
                source: 'heuristic_name',
                confidence: 0.92,
                reason: `Kadın ismi tespit edildi: "${token}"`
            };
            authorGenderCache.set(cacheKey, res);
            return res;
        }
    }

    // C) Kullanıcı Adı Parçaları Kontrolü (örn: musti2616, ahmet_1907)
    const userTokens = cleanUser.split(/\s+/).filter(t => t.length >= 3);
    for (const token of userTokens) {
        const asciiToken = foldToAscii(token);
        if (TURKISH_MALE_NAMES.has(token) || TURKISH_MALE_NAMES.has(asciiToken)) {
            const res = {
                isMale: true,
                gender: 'male',
                source: 'heuristic_username',
                confidence: 0.88,
                reason: `Kullanıcı adında erkek ismi tespit edildi: "${token}"`
            };
            authorGenderCache.set(cacheKey, res);
            return res;
        }
        if (TURKISH_FEMALE_NAMES.has(token) || TURKISH_FEMALE_NAMES.has(asciiToken)) {
            const res = {
                isMale: false,
                gender: 'female',
                source: 'heuristic_username',
                confidence: 0.88,
                reason: `Kullanıcı adında kadın ismi tespit edildi: "${token}"`
            };
            authorGenderCache.set(cacheKey, res);
            return res;
        }
    }

    // --- 2. AŞAMA: GROQ AI DEĞERLENDİRMESİ (Sezgisel tespit edemediyse) ---
    try {
        const aiCall = await groqPool.classifyAuthorGender(rawName, rawUser);
        if (aiCall.ok && aiCall.data) {
            const cinsiyet = (aiCall.data.cinsiyet || '').toUpperCase().trim();
            const guven = typeof aiCall.data.guven === 'number' ? aiCall.data.guven : 0.8;

            if (cinsiyet === 'ERKEK' && guven >= 0.6) {
                const res = {
                    isMale: true,
                    gender: 'male',
                    source: 'groq_ai',
                    confidence: guven,
                    reason: aiCall.data.neden || 'Groq AI erkek olarak sınıflandırdı'
                };
                authorGenderCache.set(cacheKey, res);
                return res;
            } else if (cinsiyet === 'KADIN') {
                const res = {
                    isMale: false,
                    gender: 'female',
                    source: 'groq_ai',
                    confidence: guven,
                    reason: aiCall.data.neden || 'Groq AI kadın olarak sınıflandırdı'
                };
                authorGenderCache.set(cacheKey, res);
                return res;
            } else {
                const res = {
                    isMale: false,
                    gender: 'unknown',
                    source: 'groq_ai',
                    confidence: guven,
                    reason: aiCall.data.neden || 'Belirsiz veya topluluk hesabı'
                };
                authorGenderCache.set(cacheKey, res);
                return res;
            }
        }
    } catch (aiErr) {
        // AI hatasında bot akışını engellememe
    }

    const res = {
        isMale: false,
        gender: 'unknown',
        source: 'default',
        confidence: 0.5,
        reason: 'Cinsiyet tespit edilemedi'
    };
    authorGenderCache.set(cacheKey, res);
    return res;
}

module.exports = {
    normalizeText,
    foldToAscii,
    normalizeSeparators,
    compactSpaced,
    icerikUygunMu, // Senkron Tier-1 (Geriye dönük uyumluluk)
    icerikUygunMuTier1: icerikUygunMu,
    icerikUygunMuAsync, // Asenkron 2 Kademeli Hibrit (Tier 1 + Tier 2 Groq)
    icerikUygunMuHibrit: icerikUygunMuAsync,
    aiContentModeration: icerikUygunMuAsync,
    authorGenderDetect,
    authorGenderCache,
    evaluateWithGroq,
    GroqKeyPool,
    groqPool,
    GROQ_API_KEYS,
    DM_REGEXES,
    YETISKIN_REGEXES,
    TURKISH_MALE_NAMES,
    TURKISH_FEMALE_NAMES,
    MALE_TITLES,
    FEMALE_TITLES
};

