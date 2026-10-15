// Alt süreçlere (Next sunucusu, bun build) geçirilecek ortam değişkenleri: kabuğun ortamından yalnızca gerekenler,
// ileride tanımlanacak bir NEXT_PUBLIC_* paketin içine gömülmesin ya da sunucuya sızmasın.
// Windows'ta bunlar olmadan Node/bun kendi kurulum yollarını bulamaz: SystemRoot/windir (soket ve crypto),
// TEMP/TMP, USERPROFILE/APPDATA/LOCALAPPDATA (kullanıcı dizinleri), ComSpec/PATHEXT (shell ve .cmd çalıştırma).
const BASE = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"SystemRoot",
	"windir",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ComSpec",
	"PATHEXT",
];

// Windows'ta değişken adları büyük/küçük harf duyarsız (Path, PATH): adı büyük harfe çevirip karşılaştır,
// çocuk sürece parent'taki yazımıyla ver. Boş değerler atılır.
function pickEnv(extraNames = []) {
	const wanted = new Set([...BASE, ...extraNames].map((name) => name.toUpperCase()));
	return Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value && wanted.has(name.toUpperCase())));
}

module.exports = { pickEnv };
