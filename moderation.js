// 1000Kitap Akıllı İçerik Moderasyon ve Filtreleme Modülü
// Uygunsuz (+18 / yetişkin / erotik) ve DM / mesaj / sohbet daveti içeren gönderileri tespit eder.
// Edebi kitap alıntıları, şiirler ve felsefi alıntılarda sıfır yanlış pozitif (zero false-positive) hedeflenmiştir.

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
        regex: /\b(?:amc[ıi]k|amc[ıi][gğ][ıi]m|amc[ıi][gğ][ıi]|amc[ıi][gğ][ıi]na|amc[ıi][gğ][ıi]nda|amc[ıi][gğ][ıi]ndan|yarrak|yarak|yara[gğ][ıi]m|yara[gğ][ıi]|yara[gğ][ıi]na|yara[gğ][ıi]nda|yara[gğ][ıi]ndan|da[sş][sş]ak|ta[sş]ak|ta[sş][sş]ak)\b/iu,
        neden: 'Açık müstehcen organ argosu'
    },
    {
        regex: /\b(?:g[oö]t[uü]n[uü]|g[oö]t[uü]me|g[oö]t[uü]nden|g[oö]t[uü]ne|koca\s*g[oö]t|dar\s*g[oö]t)\b/iu,
        neden: 'Müstehcen kalça/göt argosu'
    },
    {
        regex: /\b(?:am[ıi]n[ıi]|am[ıi]ma|am[ıi]na|am[ıi]nda|am[ıi]ndan|[ıi]slak\s*am|dar\s*am|sulu\s*am)\b/iu,
        neden: 'Müstehcen organ kullanımı'
    },
    {
        regex: /\b(?:am[ıi]na\s*koyay[ıi]m|am[ıi]na\s*koyim|amk|aq|a\.q|o\.ç|orospu|orospuluk|kahpe|gavat|pezevenk)\b/iu,
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

module.exports = {
    normalizeText,
    foldToAscii,
    normalizeSeparators,
    compactSpaced,
    icerikUygunMu,
    DM_REGEXES,
    YETISKIN_REGEXES
};
