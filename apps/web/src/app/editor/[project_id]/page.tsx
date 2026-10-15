"use client";

import dynamic from "next/dynamic";

// The editor is fully client-side. Rendering it on the server evaluates
// opencut-wasm at import, which fails where WebAssembly.instantiateStreaming
// is missing (the Electron utilityProcess running the standalone server).
const EditorPage = dynamic(() => import("./editor-page"), { ssr: false });

export default function Page() {
	return <EditorPage />;
}
