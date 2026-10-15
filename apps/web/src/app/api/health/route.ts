export async function GET() {
	// Desktop: main.js bu değeri bekler, port başka bir süreç tarafından kapılmadıysa yalnızca bizim sunucu bilir
	return new Response(process.env.CCUT_SERVER_PROOF ?? "OK", { status: 200 });
}
