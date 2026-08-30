// What is for sale, in one place. The advertising page draws its price cards
// from this list, the enquiry form fills its dropdown from it, and the admin
// page turns a stored id back into words and a price.
//
// It used to live in three places at once — the prices as text in the HTML,
// the ids in the form, and nothing at all in the admin, which showed enquiries
// as "social-4" with no idea what that cost. One list, so they cannot drift.
export const PACKS = [
  { id: 'banner-7', name: 'ads_p_banner', period: 'ads_7days', price: 19, save: null,
    ru: 'Баннер на главной, 7 дней' },
  { id: 'banner-30', name: 'ads_p_banner', period: 'ads_30days', price: 59, save: 'ads_save22',
    ru: 'Баннер на главной, 30 дней' },
  { id: 'all-7', name: 'ads_p_all', period: 'ads_7days', price: 39, save: null,
    ru: 'Баннер во всех разделах, 7 дней' },
  { id: 'all-30', name: 'ads_p_all', period: 'ads_30days', price: 119, save: 'ads_save24',
    ru: 'Баннер во всех разделах, 30 дней' },
  { id: 'social-1', name: 'ads_p_social', period: 'ads_one_post', price: 29, save: null,
    ru: 'Пост в Telegram + сторис в Instagram и TikTok, 1 пост' },
  { id: 'social-4', name: 'ads_p_social', period: 'ads_four_posts', price: 89, save: 'ads_save23',
    ru: 'Посты в Telegram + сторис в Instagram и TikTok, 4 поста' },
  { id: 'everything', name: 'ads_p_all_in', period: 'ads_30days', price: 199, save: null, wide: true,
    ru: 'Всё сразу: баннеры + соцсети + упоминание в игре, 30 дней' },
];

export const packById = (id) => PACKS.find(p => p.id === id) || null;
