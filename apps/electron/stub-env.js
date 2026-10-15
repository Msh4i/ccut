// Next'in zod env doğrulamasını (apps/web/src/env/web.ts) geçmek için yer tutucular.
// Build'de ve çalışırken aynı değerler kullanılır (main.js sırrı çalışırken rastgele ile ezer).
// Sunucu servisleri (giriş, ses arama, geri bildirim) masaüstünde bilerek çalışmaz, editör etkilenmez.
module.exports = {
	NEXT_PUBLIC_DESKTOP: "1", // layout/next.config: üçüncü taraf betikleri ve resim optimizasyonunu kapatır
	DATABASE_URL: "postgresql://desktop:desktop@127.0.0.1:1/desktop",
	BETTER_AUTH_SECRET: "desktop-build-placeholder",
	UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9",
	UPSTASH_REDIS_REST_TOKEN: "desktop-placeholder",
	NEXT_PUBLIC_SITE_URL: "ccut://app", // main.js özel şeması: auth istemcisi başka bir yerel porta gitmesin
	NEXT_PUBLIC_MARBLE_API_URL: "http://127.0.0.1:9",
	MARBLE_WORKSPACE_KEY: "desktop-placeholder",
	FREESOUND_CLIENT_ID: "desktop-placeholder",
	FREESOUND_API_KEY: "desktop-placeholder",
};
