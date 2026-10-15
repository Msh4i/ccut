import { type NextRequest, NextResponse } from "next/server";

// Desktop (Electron) only: every request, including /api/* and static assets,
// must carry the per-launch token. No-op for the normal web build; a desktop build
// (NEXT_PUBLIC_DESKTOP=1) without a token rejects everything instead of failing open.
export function proxy(request: NextRequest) {
	const token = process.env.CCUT_DESKTOP_TOKEN;
	const desktop = process.env.NEXT_PUBLIC_DESKTOP === "1";
	if ((desktop || token) && (!token || request.headers.get("x-ccut-token") !== token)) {
		return new NextResponse(null, { status: 403 });
	}
	return NextResponse.next();
}
