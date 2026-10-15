"use client";

import { useEffect, useState } from "react";
import { getMcpBridge, type McpBridge, type McpState } from "./bridge";

/** The bridge of this window (null in a browser) and the live state of the integration. */
export function useMcpState(): { bridge: McpBridge | null; state: McpState | null } {
	const [bridge] = useState(() => (typeof window === "undefined" ? null : getMcpBridge()));
	const [state, setState] = useState<McpState | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let current = true;
		void bridge.state().then((initial) => {
			if (current && initial) setState(initial);
		});
		const stop = bridge.onStateChanged((next) => setState(next));
		return () => {
			current = false;
			stop();
		};
	}, [bridge]);

	return { bridge, state };
}
