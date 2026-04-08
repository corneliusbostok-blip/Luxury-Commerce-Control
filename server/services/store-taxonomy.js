/**
 * Butikstyper + underkategorier (DA labels) — én kilde for admin + kategori-inference.
 */

"use strict";

/** @type {{ id: string, label: string, patterns: RegExp[] }[]} */
const CATEGORY_META_EXTENDED = [
  { id: "womens_dresses", label: "Kjoler", patterns: [/kjole|kjoler|\bdress\b|gown|cocktail|ball gown|maxi dress/i] },
  {
    id: "womens_tops",
    label: "Toppe & bluser",
    patterns: [/bluse|top\b|tank top|t-shirt|tee|camisole|bodystocking|peplum/i, /women.*shirt|ladies.*shirt|dame.*top/i],
  },
  {
    id: "womens_trousers",
    label: "Bukser & jeans (dame)",
    patterns: [/dame.*bukser|women.*jean|ladies.*trouser|women.*pant|mom\s+jean|high\s*waist\s*jean/i],
  },
  {
    id: "womens_outerwear",
    label: "Jakker & frakker (dame)",
    patterns: [/dame.*jakke|women.*jacket|women.*coat|ladies.*blazer|dame.*frakke|puffer.*women/i],
  },
  { id: "womens_lingerie", label: "Lingeri & nattøj", patterns: [/lingeri|nattøj|nattø|corset|bh\b|brystholder|trusser|baby doll/i] },
  {
    id: "mens_shirts_tees",
    label: "T-shirts & skjorter (herre)",
    patterns: [/t-shirt|tee\b|polo|skjorte|button-?down|oxford|linen\s+shirt|herre.*shirt|mens.*shirt/i],
  },
  {
    id: "mens_trousers",
    label: "Bukser & jeans (herre)",
    patterns: [/herre.*bukser|mens.*chino|mens.*jean|men.*trouser|\bchino\b|\bjean\b|bukser|5[-\s]?pocket/i],
  },
  { id: "mens_jackets", label: "Jakker (herre)", patterns: [/herre.*jakke|mens.*jacket|mens.*blazer|jakke|frakke/i] },
  { id: "mens_underwear", label: "Undertøj (herre)", patterns: [/underwear|boxer|trunk|undertøj|herre.*brief/i] },
  { id: "kids_baby", label: "Baby (0–2 år)", patterns: [/baby\b|toddler|nyfødt|spædbarn|0-24|0\s*-\s*2/i] },
  { id: "kids_girls", label: "Pige", patterns: [/pige|girls|girl\s+size|kids.*girl|children.*girl/i] },
  { id: "kids_boys", label: "Dreng", patterns: [/dreng|boys|boy\s+size|kids.*boy|children.*boy/i] },
  { id: "kids_activewear", label: "Sportstøj (børn)", patterns: [/børn.*sport|kids.*sport|youth.*active|junior.*gym/i] },
  { id: "fashion_bags", label: "Tasker", patterns: [/taske|tasker|handbag|tote|crossbody|clutch|skuldertaske|rygsæk/i] },
  {
    id: "fashion_jewelry",
    label: "Smykker (accessories)",
    patterns: [/ørering|anklet|charm\s+arm|smykkesæt|body chain/i],
  },
  { id: "fashion_sunglasses", label: "Solbriller", patterns: [/solbrille|sunglass|aviator|wayfarer/i] },
  { id: "fashion_belts", label: "Bælter", patterns: [/bælte|belt\b|cinturon/i] },

  { id: "footwear_sneakers", label: "Sneakers", patterns: [/sneaker|trainer|tennis shoe|running\s+shoe|low.*top.*shoe/i] },
  { id: "footwear_boots", label: "Støvler", patterns: [/\bstøvle|boot\b|chelsea boot|ankle boot|winter boot/i] },
  { id: "footwear_sandals", label: "Sandaler", patterns: [/sandal|flip-?flop|klip-klap|slides?\b/i] },
  { id: "footwear_heels", label: "Høje hæle", patterns: [/hæl|high heel|stiletto|pumps?\b|heel\b/i] },
  { id: "footwear_sports", label: "Sportssko", patterns: [/sportssko|cleat|fodboldstøvle|basketball shoe|golf shoe/i] },
  { id: "footwear_work", label: "Arbejdssko", patterns: [/arbejdssko|work boot|safety shoe|steel toe|sikkerhedssko/i] },

  { id: "furniture_sofas", label: "Sofaer", patterns: [/sofa|couch|loveseat|sectional|hjørnesofa/i] },
  { id: "furniture_tables", label: "Borde", patterns: [/spisebord|coffee table|side table|skrivebord|dining table|bord\b/i] },
  { id: "furniture_chairs", label: "Stole", patterns: [/\bstol\b|armchair|office chair|dining chair|recliner/i] },
  { id: "furniture_beds", label: "Senge", patterns: [/\bseng\b|bed frame|madras|mattress|daybed/i] },
  { id: "home_rugs", label: "Tæpper", patterns: [/\btæppe\b|rug\b|løber|area rug|vægtæppe/i] },
  { id: "kitchen_serveware", label: "Service", patterns: [/service|stel|porcelæn|fad\b|tallerken|kop\b|krystalglas/i] },
  { id: "home_bathroom", label: "Badeværelse", patterns: [/badeværelse|bath mat|bruseforhæng|håndklæde|bathroom/i] },
  { id: "storage_home", label: "Opbevaring", patterns: [/opbevaring|storage box|kasse\b|kurv\b|reol|skab\b|organizer/i] },

  { id: "beauty_foundation", label: "Foundation", patterns: [/foundation|primer|bb cream|cc cream|concealer/i] },
  { id: "beauty_mascara", label: "Mascara", patterns: [/mascara/i] },
  { id: "beauty_lipstick", label: "Læbestift", patterns: [/læbestift|lipstick|lip gloss|læbeolie/i] },
  { id: "skincare_face", label: "Ansigtspleje", patterns: [/ansigtscreme|serum|hydration|anti-?age|retinoid|toner|ansigtspleje/i] },
  { id: "skincare_body", label: "Kropspleje", patterns: [/body lotion|body scrub|kropspleje|body butter|barbercreme/i] },
  { id: "haircare", label: "Hårpleje", patterns: [/shampoo|balsam|conditioner|hårkur|hårpleje|hair mask/i] },
  { id: "perfume", label: "Parfume", patterns: [/parfume|eau de|cologne|duft\b|fragrance/i] },
  { id: "grooming", label: "Barbering & grooming", patterns: [/barber|skraber|shaving|trimmer|grooming|skæg\b/i] },

  { id: "elec_laptops", label: "Laptops", patterns: [/laptop|notebook|macbook\b|chromebook/i] },
  { id: "elec_desktops", label: "Stationære PC", patterns: [/desktop|stationær|tower pc|imac\b|mini pc/i] },
  { id: "elec_mobile", label: "Mobil & tablets", patterns: [/smartphone|iphone|android|tablet|ipad|galaxy tab/i] },
  { id: "elec_tv_audio", label: "TV & lyd", patterns: [/\btv\b|television|soundbar|højttaler|headphone|headset|earbud/i] },
  { id: "gaming_consoles", label: "Konsoller", patterns: [/playstation|xbox|nintendo switch|gaming console|steam deck/i] },
  { id: "elec_accessories", label: "Tilbehør (elektronik)", patterns: [/charger|kabel|adapter|hub\b|cover|case\b.*phone|powerbank/i] },
  { id: "smart_home", label: "Smart home", patterns: [/smart home|smart plug|philips hue|alexa|google nest|ring doorbell/i] },

  { id: "toys_building", label: "Byggesæt", patterns: [/lego|building block|konstruktion|byggesæt/i] },
  { id: "toys_dolls", label: "Dukker", patterns: [/dukke|doll\b|barbie|figur.*baby/i] },
  { id: "toys_vehicles", label: "Legetøjsbiler", patterns: [/legetøjsbil|diecast|hot wheels|model car toy/i] },
  { id: "games_board", label: "Brætspil", patterns: [/brætspil|board game|catan|risk\b|monopoly/i] },
  { id: "games_puzzles", label: "Puslespil", patterns: [/puslespil|jigsaw|puzzle\b/i] },
  { id: "hobby_paint", label: "Maling", patterns: [/maling|akryl|oliefarve|staffeli|canvas/i] },
  { id: "hobby_textile", label: "Strik & syning", patterns: [/strik|syning|garn|needlework|embroidery|sytøj/i] },
  { id: "collectibles", label: "Samleobjekter", patterns: [/samleobjekt|collector|funko|limited edition figur|trading card/i] },

  { id: "sports_fitness", label: "Fitness", patterns: [/fitness|gym|kettlebell|dumbbell|yoga mat|vægtstang/i] },
  { id: "sports_camping", label: "Camping", patterns: [/camping|telt\b|sovepose|campingsæt/i] },
  { id: "sports_hiking", label: "Vandring", patterns: [/vandrestav|hiking boot|rygsæk.*vandring|trekking/i] },
  { id: "sports_cycling", label: "Cykling", patterns: [/cykel|cykling|bike helmet|cycling jersey|pedal\b/i] },
  { id: "sports_running", label: "Løb", patterns: [/\bløb\b|running shoe|løbesko|garmin.*run/i] },
  { id: "sports_accessories", label: "Sportstilbehør", patterns: [/sportstilbehør|water bottle|svedbånd|gym taske/i] },

  { id: "pets_dogs_food", label: "Hundefoder", patterns: [/hundefoder|dog food|kibble|hundemad/i] },
  { id: "pets_dogs_toys", label: "Hundelegetøj", patterns: [/hundelegetøj|dog toy|tyggeben|kong toy/i] },
  { id: "pets_cats", label: "Katte", patterns: [/kattemad|cat litter|kattet|cat tree|scratch post/i] },
  { id: "pets_fish", label: "Fisk / akvarie", patterns: [/akvarie|aquarium|fiskemad|fish tank/i] },
  { id: "pets_small", label: "Smådyr", patterns: [/hamster|kanin|marsvin|smådyr|guinea pig/i] },
  { id: "pets_care", label: "Pleje (kæledyr)", patterns: [/pote balsam|dyreshampoo|flea|tick|grooming dog/i] },

  { id: "food_deli", label: "Delikatesser", patterns: [/delikates|charcuteri|trøffel|foie|specialitet mad/i] },
  { id: "food_snacks", label: "Snacks", patterns: [/snack|chips|nødder mix|protein bar/i] },
  { id: "food_drinks", label: "Drikkevarer", patterns: [/sodavand|juice|smoothie|drik\b(?!.*kaffe)/i] },
  { id: "food_coffee", label: "Kaffe", patterns: [/kaffe|espresso|arabica|coffee bean/i] },
  { id: "food_tea", label: "Te", patterns: [/\bte\b|oolong|chai|earl grey|tepose/i] },
  { id: "food_organic", label: "Økologisk", patterns: [/økologisk|organic certified|bio\s|eu øko/i] },
  { id: "supplements", label: "Kosttilskud", patterns: [/kosttilskud|vitamin|omega-?3|proteinpulver|supplement/i] },

  { id: "baby_gear", label: "Babyudstyr", patterns: [/babyudstyr|changing mat|bæresele|baby carrier/i] },
  { id: "baby_strollers", label: "Barnevogne", patterns: [/barnevogn|stroller|kombivogn|buggy/i] },
  { id: "baby_car_seats", label: "Autostole", patterns: [/autostol|car seat|isofix/i] },
  { id: "baby_clothes", label: "Tøj (baby)", patterns: [/baby.*body|baby.*heldragt|sparkedragt/i] },
  { id: "baby_toys", label: "Legetøj (baby)", patterns: [/babygynge|rangle|baby toy|aktivitetslegetøj/i] },
  { id: "baby_care", label: "Pleje (baby)", patterns: [/baby shampoo|bleer|diaper|baby lotion|sut\b/i] },

  { id: "auto_accessories", label: "Biltilbehør", patterns: [/biltilbehør|car mount|dashcam|bilmåtte/i] },
  { id: "auto_parts", label: "Reservedele", patterns: [/reservedel|oil filter|brake pad|alternator/i] },
  { id: "auto_care", label: "Bilpleje", patterns: [/bilpleje|car wax|shampoo bil|polish bil/i] },
  { id: "auto_electronics", label: "Elektronik til bil", patterns: [/car stereo|obd|car charger|backup camera/i] },

  { id: "books_fiction", label: "Skønlitteratur", patterns: [/roman|fiction novel|krimi|fantasy bog/i] },
  { id: "books_nonfiction", label: "Faglitteratur", patterns: [/faglitteratur|non-?fiction|biografi|lærebog/i] },
  { id: "books_ebooks", label: "E-bøger", patterns: [/e-bog|ebook|kindle edition|pdf bog/i] },
  { id: "media_music", label: "Musik", patterns: [/vinyl|cd\b|musikalbum|soundtrack/i] },
  { id: "media_film", label: "Film", patterns: [/blu-?ray|dvd|4k uhd film/i] },

  { id: "office_supplies", label: "Kontorartikler", patterns: [/kontorartikler|pen\b|notesbog|stifter|papir\b/i] },
  { id: "office_furniture", label: "Kontormøbler", patterns: [/kontorstol|hæve-sænke|reception disk|kontormøbel/i] },
  { id: "office_software", label: "Software (erhverv)", patterns: [/microsoft 365|adobe license|saas|erp software/i] },
  { id: "office_printers", label: "Printere & tilbehør", patterns: [/printer|scanner|toner|ink cartridge/i] },

  { id: "gifts_personal", label: "Personlige gaver", patterns: [/personlig gave|gravering|monogram|custom gift/i] },
  { id: "gifts_hampers", label: "Gavekurve", patterns: [/gavekurv|hamper|gourmetkurv/i] },
  { id: "gifts_experiences", label: "Oplevelsesgaver", patterns: [/oplevelsesgave|experience gift|spa weekend ticket/i] },
  { id: "gifts_seasonal", label: "Sæsonvarer", patterns: [/julekalender|påske|halloween|seasonal gift set/i] },

  { id: "garden_tools", label: "Haveudstyr", patterns: [/hækklipper|græsslåmaskine|haven|spade\b|rive\b/i] },
  { id: "garden_plants", label: "Planter", patterns: [/plante|frø pose|stueplante|haveplante|bonsai/i] },
  { id: "diy_tools", label: "Værktøj", patterns: [/skruetrækker|hammer|boremaskine|værktøjssæt|wrench/i] },
  { id: "diy_materials", label: "Byggematerialer", patterns: [/træplade|gips|flise|cement|isolation/i] },

  { id: "jewel_necklaces", label: "Halskæder", patterns: [/halskæde|necklace|vedhæng|pendant chain/i] },
  { id: "jewel_bracelets", label: "Armbånd", patterns: [/armbånd|bracelet|charm bracelet/i] },
  { id: "jewel_rings", label: "Ringe", patterns: [/ring\b|diamantring|forlovelsesring/i] },

  { id: "art_paintings", label: "Malerier", patterns: [/maleri|oil painting|canvas art|kunstværk/i] },
  { id: "art_posters", label: "Plakater", patterns: [/plakat|poster print|wall art print/i] },
  { id: "art_handmade", label: "Håndlavede produkter", patterns: [/håndlavet|handmade ceramic|crafted\b/i] },
  { id: "art_digital", label: "Digital kunst", patterns: [/nft|digital download art|printable art/i] },

  { id: "travel_luggage", label: "Kufferter", patterns: [/kuffert|luggage|carry-?on|rolling suitcase/i] },
  { id: "travel_gear", label: "Rejseudstyr", patterns: [/rejseudstyr|neck pillow|rejseadapter|packing cube/i] },
  { id: "travel_accessories", label: "Rejse accessories", patterns: [/pas cover|rejsetaske|toilettaske rejse/i] },
  { id: "travel_outdoor", label: "Outdoor gear", patterns: [/taktisk rygsæk|survival kit|outdoor gear/i] },

  { id: "cleaning_products", label: "Rengøringsmidler", patterns: [/rengøringsmiddel|floor cleaner|disinfectant|blegemiddel/i] },
  { id: "cleaning_tools", label: "Rengøringsredskaber", patterns: [/mop\b|børste|svamp|vinduesvisker/i] },
  { id: "cleaning_eco", label: "Bæredygtige husholdningsprodukter", patterns: [/bæredygtig rengøring|refill station|eco refill/i] },

  { id: "digital_courses", label: "Online kurser", patterns: [/online kursus|masterclass|video course access/i] },
  { id: "digital_templates", label: "Templates", patterns: [/notion template|canva template|figma template/i] },
  { id: "digital_software", label: "Software (digital)", patterns: [/software license|download license|lifetime deal app/i] },
  { id: "digital_ebooks", label: "E-books (digital produkt)", patterns: [/pdf guide|download ebook|digital workbook/i] },
];

const LEGACY_LABELS_DA = {
  shirts: "Skjorter",
  polos: "Polos",
  knitwear: "Strik",
  trousers: "Bukser",
  outerwear: "Overtøj",
  shoes: "Sko",
  watches: "Ure",
  accessories: "Tilbehør",
  lighting: "Lamper & belysning",
  furniture: "Møbler",
  home_decor: "Pyntegenstande & indretning",
  kitchen: "Køkken & køkkenudstyr",
  home_textiles: "Tekstiler",
  other: "Andet",
};

const STORE_VERTICALS = [
  {
    key: "fashion",
    label: "👕 Tøj & mode",
    categoryIds: [
      "womens_dresses",
      "womens_tops",
      "womens_trousers",
      "womens_outerwear",
      "womens_lingerie",
      "mens_shirts_tees",
      "mens_trousers",
      "mens_jackets",
      "mens_underwear",
      "kids_baby",
      "kids_girls",
      "kids_boys",
      "kids_activewear",
      "fashion_bags",
      "fashion_jewelry",
      "fashion_sunglasses",
      "fashion_belts",
      "shirts",
      "polos",
      "knitwear",
      "trousers",
      "outerwear",
      "accessories",
    ],
  },
  {
    key: "footwear",
    label: "👟 Sko & fodtøj",
    categoryIds: ["footwear_sneakers", "footwear_boots", "footwear_sandals", "footwear_heels", "footwear_sports", "footwear_work", "shoes"],
  },
  {
    key: "home",
    label: "🏠 Hus & bolig",
    categoryIds: [
      "lighting",
      "furniture",
      "home_decor",
      "kitchen",
      "home_textiles",
      "furniture_sofas",
      "furniture_tables",
      "furniture_chairs",
      "furniture_beds",
      "home_rugs",
      "kitchen_serveware",
      "home_bathroom",
      "storage_home",
    ],
  },
  {
    key: "beauty",
    label: "💄 Skønhed & personlig pleje",
    categoryIds: [
      "beauty_foundation",
      "beauty_mascara",
      "beauty_lipstick",
      "skincare_face",
      "skincare_body",
      "haircare",
      "perfume",
      "grooming",
    ],
  },
  {
    key: "electronics",
    label: "🖥️ Elektronik",
    categoryIds: [
      "elec_laptops",
      "elec_desktops",
      "elec_mobile",
      "elec_tv_audio",
      "gaming_consoles",
      "elec_accessories",
      "smart_home",
    ],
  },
  {
    key: "toys",
    label: "🧸 Legetøj & hobby",
    categoryIds: [
      "toys_building",
      "toys_dolls",
      "toys_vehicles",
      "games_board",
      "games_puzzles",
      "hobby_paint",
      "hobby_textile",
      "collectibles",
    ],
  },
  {
    key: "sports",
    label: "🏋️ Sport & fritid",
    categoryIds: [
      "sports_fitness",
      "sports_camping",
      "sports_hiking",
      "sports_cycling",
      "sports_running",
      "sports_accessories",
    ],
  },
  {
    key: "pets",
    label: "🐶 Kæledyr",
    categoryIds: ["pets_dogs_food", "pets_dogs_toys", "pets_cats", "pets_fish", "pets_small", "pets_care"],
  },
  {
    key: "food",
    label: "🍔 Mad & drikke",
    categoryIds: ["food_deli", "food_snacks", "food_drinks", "food_coffee", "food_tea", "food_organic", "supplements"],
  },
  {
    key: "baby",
    label: "👶 Baby & børn",
    categoryIds: ["baby_gear", "baby_strollers", "baby_car_seats", "baby_clothes", "baby_toys", "baby_care"],
  },
  {
    key: "auto",
    label: "🚗 Auto & tilbehør",
    categoryIds: ["auto_accessories", "auto_parts", "auto_care", "auto_electronics"],
  },
  {
    key: "books_media",
    label: "📚 Bøger & medier",
    categoryIds: ["books_fiction", "books_nonfiction", "books_ebooks", "media_music", "media_film"],
  },
  {
    key: "office",
    label: "🧑‍💼 Kontor & erhverv",
    categoryIds: ["office_supplies", "office_furniture", "office_software", "office_printers"],
  },
  {
    key: "gifts",
    label: "🎁 Gaver & specialbutikker",
    categoryIds: ["gifts_personal", "gifts_hampers", "gifts_experiences", "gifts_seasonal"],
  },
  {
    key: "garden_diy",
    label: "🌱 Have & gør-det-selv",
    categoryIds: ["garden_tools", "garden_plants", "diy_tools", "diy_materials"],
  },
  {
    key: "jewelry_watches",
    label: "💍 Smykker & ure",
    categoryIds: ["jewel_necklaces", "jewel_bracelets", "jewel_rings", "watches"],
  },
  {
    key: "art_design",
    label: "🎨 Kunst & design",
    categoryIds: ["art_paintings", "art_posters", "art_handmade", "art_digital"],
  },
  {
    key: "travel",
    label: "🧳 Rejse & livsstil",
    categoryIds: ["travel_luggage", "travel_gear", "travel_accessories", "travel_outdoor"],
  },
  {
    key: "cleaning",
    label: "🧼 Rengøring & husholdning",
    categoryIds: ["cleaning_products", "cleaning_tools", "cleaning_eco"],
  },
  {
    key: "digital",
    label: "⚡ Digitale produkter",
    categoryIds: ["digital_courses", "digital_templates", "digital_software", "digital_ebooks"],
  },
];

const ALL_MERGED_CATEGORY_IDS = [
  ...new Set(
    STORE_VERTICALS.flatMap((v) => v.categoryIds).filter((id) => id && id !== "other")
  ),
]
  .sort((a, b) => {
    if (a === "other") return 1;
    if (b === "other") return -1;
    return a.localeCompare(b);
  })
  .concat(["other"]);

const LABELS_DA = { ...LEGACY_LABELS_DA };
for (const row of CATEGORY_META_EXTENDED) {
  LABELS_DA[row.id] = row.label;
}

function inferStoreVerticalKey(categorySlugs) {
  const ids = (categorySlugs || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return "fashion";
  for (const v of STORE_VERTICALS) {
    const set = new Set(v.categoryIds);
    if (ids.every((id) => set.has(id))) return v.key;
  }
  return "all";
}

module.exports = {
  STORE_VERTICALS,
  CATEGORY_META_EXTENDED,
  ALL_MERGED_CATEGORY_IDS,
  LABELS_DA,
  inferStoreVerticalKey,
};
