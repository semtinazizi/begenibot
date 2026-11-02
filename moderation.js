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
    // 2. DM davetleri ve tamlamaları ("dm gelin", "dm at", "dm atın", "dm kutum", "dm açık", "dm bekliyorum", "dm düş", "dm buyrun")
    {
        regex: /(?:^|[^\p{L}\p{N}])dm\s+(?:gelin|gel|at|at[ıi]n|atin|ats[ıi]n|atsin|atabilir|atabilirsiniz|ata\s*bilirsiniz|atar\s*m[ıi]s[ıi]n[ıi]z?|kutum|kutusu|kutuma|a[cç][ıi]k|acik|bekliyorum|beklerim|buyrun|buyurun|serbest|d[uü][sş]|yaz[ıi]n|yaz|yazabilirsiniz|l[uü]tfen|pls)(?:[^\p{L}\p{N}]|$)/iu,
        neden: 'DM çağrısı / daveti'
    },
    // 3. PM (Private Message) davetleri ("pm at", "pm atın", "pm bekliyorum", "pm açık", "pm gelin")
    {
        regex: /(?:^|[^\p{L}\p{N}])pm(?:\s*(?:at|at[ıi]n|ats[ıi]n|atabilir|atabilirsiniz|gelin|yaz[ıi]n|bekliyorum|beklerim|a[cç][ıi]k|kutum)|'?(?:den|dan|e|ye|de|da))(?:[^\p{L}\p{N}]|$)/iu,
        neden: 'PM (Özel Mesaj) çağrısı'
    },
    // 4. "canı sıkılan dm", "canı sıkılan dme", "canı sıkılan mesaj", "canı sıkılan yazsın", "canı sıkılan gelsin"
    {
        regex: /can[ıi]\s*s[ıi]k[ıi]lan(?:\s*olan)?(?:\s*varsa)?(?:\s*biri(?:si)?(?:ni)?)?(?:\s*lar)?\s*(?:dm|dme|dm'e|mesaj|yazs[ıi]n|yazsin|gelsin|konu[sş]al[ıi]m|buyursun|ula[sş]s[ıi]n|eklesin|ses\s*versin|var\s*m[ıi])/iu,
        neden: 'Canı sıkılan sohbet/DM çağrısı'
    },
    // 5. "canım sıkıldı / sıkılıyor" + sohbet/mesaj arayışı
    {
        regex: /can[ıi]m\s*(?:[cç]ok\s*)?s[ıi]k[ıi]l(?:d[ıi]|[ıi]yor)\s*(?:dm|mesaj|yaz[ıi]n|konu[sş]al[ıi]m|dertle[sş]elim|sohbet|biriyle\s*konu[sş]|konu[sş]acak|dertle[sş]ecek)/iu,
        neden: 'Canım sıkıldı sohbet/mesaj çağrısı'
    },
    // 6. "çok sıkıldım yazın", "sıkıldım mesaj atın", "sıkıldım dm"
    {
        regex: /(?:[cç]ok\s*)?s[ıi]k[ıi]ld[ıi]m\s+(?:dm|dme|mesaj|yaz[ıi]n|konu[sş]al[ıi]m|dertle[sş]elim|sohbete)/iu,
        neden: 'Sıkıldım sohbet/mesaj çağrısı'
    },
    // 7. "konuşmak isteyen mesaj atsın", "konuşmak isteyen yazsın", "sohbet etmek isteyen dm", "konuşmak isteyen var mı?"
    {
        regex: /(?:tan[ıi][sş]mak|konu[sş]mak|dertle[sş]mek|yaz[ıi][sş]mak|sohbet\s*etmek|muhabbet\s*etmek|arkada[sş]\s*olmak|vakit\s*ge[cç]irmek|kaynatmak)\s*(?:isteyen|isteyenler|arayan|arayanlar)(?:(?:\s*[\?!]+|\s*$)|(?:\s+(?:varsa|olursa|biri(?:si)?(?:ni)?|birileri(?:ni)?|olan|herkes|herkesi|bana|[oö]zelden|[oö]zel|l[uü]tfen)){0,3}(?:\s+(?:mesaj\s*(?:at[ıi]n?|ats[ıi]n|atabilir|atabilirsiniz|g[oö]nderin)?|yaz[ıi]n?|yazs[ıi]n|yazabilir|dm|gelsin|gelin|ula[sş][ıi]n?|ula[sş]s[ıi]n|eklesin|ekleyin|buyursun|buyrun|bekliyorum|beklerim|buraday[ıi]m|burday[ıi]m|buralarday[ıi]m|var\s*m[ıi]|[\?!]+|$)))/iu,
        neden: 'Tanışma / konuşma / dertleşme / sohbet çağrısı'
    },
    // 8. "konuşacak / sohbet edecek / dertleşecek biri var mı / arıyorum / kimse yok mu"
    {
        regex: /(?:konu[sş]acak|sohbet\s*edecek|dertle[sş]ecek|tan[ıi][sş]acak|yaz[ıi][sş]acak|muhabbet\s*edecek)\s+(?:biri(?:si)?(?:ni|yle|le|ne|den)?|birileri(?:ni|yle)?|arkada[sş]|dost|kimse|k[ıi]z|bayan)?\s*(?:var\s*m[ıi]|yok\s*mu|ar[ıi]yorum|laz[ıi]m|bekliyorum)/iu,
        neden: 'Sohbet / konuşacak arkadaş arayışı'
    },
    // 9. "sohbete beklerim", "sohbete gelin", "muhabbete beklerim"
    {
        regex: /(?:sohbet|muhabbet)(?:e|\s+odas[ıi]na|\s+grubuna)\s*(?:beklerim|bekliyorum|gelin|gel|buyrun)/iu,
        neden: 'Sohbet odası/muhabbet daveti'
    },
    // 10. Karşılıklı teklif / soru: "konuşalım mı", "dertleşelim mi", "tanışalım mı", "sohbet edelim mi"
    {
        regex: /(?:konu[sş]al[ıi]m\s*m[ıi]|dertle[sş]elim\s*m[ıi]|tan[ıi][sş]al[ıi]m\s*m[ıi]|sohbet\s*edelim\s*mi|yaz[ıi][sş]al[ıi]m\s*m[ıi]|kaynatal[ıi]m\s*m[ıi])/iu,
        neden: 'Karşılıklı konuşma / tanışma teklifi'
    },
    // 11. "mesaj atın konuşalım", "yazın tanışalım", "dm atın dertleşelim"
    {
        regex: /(?:mesaj\s*at[ıi]n?|yaz[ıi]n?|dm\s*at[ıi]n?|gelin)\s+(?:konu[sş]al[ıi]m|dertle[sş]elim|tan[ıi][sş]al[ıi]m|sohbet\s*edelim|kaynatal[ıi]m)/iu,
        neden: 'Yazın / mesaj atın konuşalım çağrısı'
    },
    // 12. "özelden yazın", "özelden konuşalım", "özelden ulaşın", "özele gelin"
    {
        regex: /(?:[oö]zelden|[oö]zele)\s*(?:yaz[ıi]n|yaz|yazsin|yazs[ıi]n|mesaj|konu[sş]al[ıi]m|ula[sş][ıi]n|ula[sş]|bekliyorum|beklerim|yazabilirsiniz|gelin)/iu,
        neden: 'Özelden yazışma / mesaj daveti'
    },
    // 13. "özel mesaj atın", "özel mesaj bekliyorum", "özel mesaj atabilirsiniz"
    {
        regex: /[oö]zel\s*mesaj\s*(?:at[ıi]n|at|ats[ıi]n|atabilir|atabilirsiniz|bekliyorum|beklerim|g[oö]nderin|yollay[ıi]n|yaz[ıi]n)/iu,
        neden: 'Özel mesaj talebi'
    },
    // 14. "mesaj atın", "mesaj atabilirsiniz", "bana mesaj atın", "mesaj bekliyorum"
    {
        regex: /(?:bana\s+)?mesaj\s*(?:at[ıi]n|at|ats[ıi]n|atabilirsiniz|ata\s*bilirsiniz|atabilir|atar\s*m[ıi]s[ıi]n[ıi]z?|bekliyorum|beklerim|b[ıi]rak[ıi]n|g[oö]nderin|yollay[ıi]n)/iu,
        neden: 'Mesaj atın çağrısı'
    },
    // 15. "mesaj kutum açık"
    {
        regex: /mesaj\s*kutum\s*(?:a[cç][ıi]k|a[cç][ıi]kt[ıi]r|beklerim)/iu,
        neden: 'Mesaj kutusu açık çağrısı'
    },
    // 16. "bana özelden yazın"
    {
        regex: /bana\s+(?:[oö]zelden|[oö]zel)\s+(?:yaz[ıi]n|yaz|mesaj|ula[sş][ıi]n)/iu,
        neden: 'Bana özelden yaz çağrısı'
    },
    // 17. "bana yazın / bana ulaşın"
    {
        regex: /bana\s+(?:ula[sş][ıi]n|yaz[ıi]n|yazabilirsiniz)\b/iu,
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
    // 4. Edebi kitap alıntılarındaki anatomik cinsel organ isimleri
    {
        regex: /\b(?:vajina|vajinas[ıi]|vajinas[ıi]na|vajinas[ıi]nda|vajinas[ıi]ndan|vajinaya|vajinay[ıi]|vagina)\b/iu,
        neden: 'Vajina ifadesi (+18 erotik alıntı)'
    },
    {
        regex: /\b(?:penis|penisi|penisine|penisinde|penisinden|penise|penisiyle)\b/iu,
        neden: 'Penis ifadesi (+18 erotik alıntı)'
    },
    {
        regex: /\b(?:klitoris|klitorisi|klitorisine|klitorisini|klitorisiyle)\b/iu,
        neden: 'Klitoris ifadesi (+18 erotik alıntı)'
    },
    // 5. Açık müstehcen organ argosu
    {
        regex: /\b(?:amc[ıi]k|amc[ıi][gğ][ıi]|amc[ıi][gğ][ıi]na|amc[ıi][gğ][ıi]nda|amc[ıi][gğ][ıi]ndan|yarrak|yarak|yara[gğ][ıi]m|yara[gğ][ıi]|yara[gğ][ıi]na|yara[gğ][ıi]nda|yara[gğ][ıi]ndan|da[sş][sş]ak|ta[sş]ak|ta[sş][sş]ak)\b/iu,
        neden: 'Açık müstehcen organ argosu'
    },
    {
        regex: /\b(?:g[oö]t[uü]n[uü]|g[oö]t[uü]me|g[oö]t[uü]nden|g[oö]t[uü]ne|koca\s*g[oö]t|dar\s*g[oö]t)\b/iu,
        neden: 'Müstehcen kalça/göt argosu'
    },
    {
        regex: /\b(?:am[ıi]n[ıi]|am[ıi]na|am[ıi]nda|am[ıi]ndan|[ıi]slak\s*am|dar\s*am|sulu\s*am)\b/iu,
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
        regex: /\b(?:bo[sş]ald[ıi]m?|bo[sş]al[ıi]rken|bo[sş]almak\s*(?:istiyorum|istedi|[uü]zereydi)|bo[sş]alt\s*beni|i[cç]ine\s*bo[sş]al(?:d[ıi]|mak|d[ıi]m)?|a[gğ]z[ıi]na\s*bo[sş]al(?:d[ıi]|mak)?)\b/iu,
        neden: 'Cinsel boşalma ifadesi'
    },
    {
        regex: /\b(?:meni|menisini|sperm|d[oö]l|dölü|d[oö]l[uü]n[uü]|d[oö]lleme|zevk\s*suyu|zevk\s*sular[ıi])\b/iu,
        neden: 'Meni / döl / zevk suyu ifadesi (+18)'
    },
    // 9. Orgazm ifadeleri
    {
        regex: /\b(?:orgazm|orgazma\s*(?:ula[sş]t[ıi]|ula[sş]an|ula[sş]t[ıi]lar)|orgazm\s*(?:oldu|oluyor|an[ıi]nda|[cç][ıi][gğ]l[ıi][gğ][ıi])|[cç]oklu\s*orgazm)\b/iu,
        neden: 'Orgazm ifadesi (+18 erotik alıntı)'
    },
    // 10. Erotik kitap alıntılarındaki temas ve birleşme betimlemeleri
    {
        // "bacaklarını araladı", "bacaklarını ayırdı", "bacaklarının arasına dokundu/girdi", "bacaklarının arası ıslanmıştı"
        regex: /(?:bacaklar[ıi]n[ıi]\s+(?:aralad[ıi]|ay[ıi]rd[ıi]|a[cç]t[ıi]|ikiye\s+ay[ıi]rd[ıi])|bacaklar[ıi]n[ıi]n\s+aras[ıi](?:na|n[ıi]|nda)?\s+(?:dokundu|ok[sş]ad[ıi]|kayd[ıi]|[ıi]slanm[ıi][sş]t[ıi]|girdi))/iu,
        neden: 'Erotik kitap alıntısı (bacak arası / genital temas)'
    },
    {
        // "içine sertçe girdi", "içinde kaydı", "içine kökledi", "erkekliğini içine aldı", "içine soktu"
        regex: /(?:i[cç]ine\s+(?:sert[cç]e\s+)?(?:girdi|kayd[ıi]|soktu|k[oö]kledi)|erkekli[gğ]ini\s+i[cç]ine\s+ald[ıi]|i[cç]inde\s+kayd[ıi])/iu,
        neden: 'Erotik kitap alıntısı (cinsel penetrasyon betimlemesi)'
    },
    {
        // "meme uçlarını okşadı", "göğüs uçları sertleşmişti", "memelerini sıktı", "meme ucunu emdi"
        regex: /(?:(?:g[oö][gğ][uü]s|meme)\s*u[cç](?:u|lar[ıi])(?:n[ıi]|na)?(?:\s+[a-zçğıöşü]+){0,5}\s*(?:sertle[sş]|emdi|[oö]pt[uü]|ok[sş]ad[ıi]|avu[cç]lad[ıi]|ald[ıi]|s[ıi]kt[ıi]|tuttu)|memelerini\s+(?:avu[cç]lad[ıi]|s[ıi]kt[ıi]|ok[sş]ad[ıi]|emdi))/iu,
        neden: 'Erotik kitap alıntısı (göğüs/meme uyarımı)'
    },
    {
        // "kalçalarını kavradı", "kalçasını sıktı", "arkadan sertçe"
        regex: /(?:kal[cç]alar[ıi]n[ıi]\s+(?:kavrad[ıi]|s[ıi]kt[ıi]|avu[cç]lad[ıi]|ok[sş]ad[ıi]|tutup)|arkadan\s+sert[cç]e\s+girdi)/iu,
        neden: 'Erotik kitap alıntısı (kalça tutuşu / cinsel eylem)'
    },
    {
        // "zevkten inledi", "zevk çığlıkları", "inlemeleri odayı doldurdu", "zevk dolu inleme"
        regex: /(?:zevkten\s+(?:inledi|inleyerek|k[ıi]vrand[ıi]|hayk[ıi]rd[ıi]|[cç][ıi]ld[ıi]rd[ıi]|[cç][ıi][gğ]l[ıi]k)|inlemeleri\s+oday[ıi]|zevk\s*(?:[cç][ıi][gğ]l[ıi]klar[ıi]|dolu\s*inleme))/iu,
        neden: 'Erotik kitap alıntısı (zevk / cinsel inleme)'
    },
    {
        // "sertleşen erkekliği", "sertleşen penisi", "ereksiyon hali", "ıslanmış kadınlığı"
        regex: /(?:sertle[sş]en\s+(?:erkekli[gğ]i|penisi|aleti)|ereksiyon\s+hali|[ıi]slanm[ıi][sş]\s+kad[ıi]nl[ıi][gğ][ıi]|[ıi]slak\s+kad[ıi]nl[ıi][gğ][ıi])/iu,
        neden: 'Erotik kitap alıntısı (cinsel uyarılma / ereksiyon)'
    },
    {
        // "çırılçıplak soyunup yatağa", "çırılçıplak uzandılar", "üzerindekileri parçaladı"
        regex: /(?:[cç][ıi]r[ıi]l[cç][ıi]plak\s+(?:soyunup\s+yata[gğ]a|yata[gğ]a\s+uzand[ıi]|uzand[ıi]lar|[uü]zerine|yata[gğ]a)|[uü]zerindekileri\s+(?:y[ıi]rtt[ıi]|f[ıi]rlatt[ıi])\s+ve\s+yata[gğ]a)/iu,
        neden: 'Erotik kitap alıntısı (yatakta çıplaklık)'
    },
    {
        // "şehvetle seviştiler", "sevişme sahnesi", "sevişirken aldıkları haz", "çılgınca seviş", "sevişelim"
        regex: /(?:[sş]ehvetle\s+sevi[sş]|sevi[sş]me\s+sahnesi|sevi[sş]irken\s+ald[ıi]klar[ıi]\s+haz|[cç][ıi]lg[ıi]nca\s+sevi[sş]|sevi[sş]elim|sevi[sş]mek\s*isteyen|benimle\s*sevi[sş]|sevi[sş]mek\s*istiyorum)/iu,
        neden: 'Erotik sevişme betimlemesi / sevişme teklifi'
    },
    // 11. Cinsel ilişki teklifleri & cinsel içerik
    {
        regex: /\b(?:seks|sex)\s+(?:yapacak|yapmak|yapalı?m|arayan|isteyen|sohbeti|partneri|hattı?|sitesi|ilişki|sohbet|arkadaşı|pozisyonu)\b/iu,
        neden: 'Cinsel ilişki / seks teklifi'
    },
    {
        regex: /\bcinsel\s+(?:ili[sş]ki|birle[sş]me|organ|fantazi|fantezi|partner|sohbet|a[cç]l[ıi]k|tatmin)\b/iu,
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

    // 1. Yetişkin / +18 / Müstehcen / Erotik Alıntı Denetimi (Öncelikli)
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
