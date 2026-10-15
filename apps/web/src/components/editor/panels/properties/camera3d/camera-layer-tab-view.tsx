"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import type { CameraTabModel } from "@/tracking/camera3d/ui/layer-tabs";

/** The camera layer's tab as plain markup of a {@link CameraTabModel}. */
export function CameraLayerTabView({
	elementId,
	model,
	onHiddenChange,
}: {
	elementId: string;
	model: CameraTabModel;
	onHiddenChange: (hidden: boolean) => void;
}) {
	const hideId = useId();
	return (
		<Section sectionKey={`${elementId}:camera-layer`}>
			<SectionHeader>
				<SectionTitle>Tracked camera</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<dl className="flex flex-col gap-2 text-sm">
						<div className="flex justify-between gap-2">
							<dt className="text-muted-foreground">Source clip</dt>
							<dd className="truncate">{model.sourceName}</dd>
						</div>
						<div className="flex justify-between gap-2">
							<dt className="text-muted-foreground">Angle of view at the playhead</dt>
							<dd>{model.angleOfView ?? "None"}</dd>
						</div>
					</dl>
					{model.note ? <p className="text-muted-foreground text-sm">{model.note}</p> : null}
					<div className="flex items-center justify-between gap-2">
						<Label htmlFor={hideId} className="text-foreground text-sm font-normal">
							Hide
						</Label>
						<Switch id={hideId} checked={model.hidden} onCheckedChange={onHiddenChange} />
					</div>
					<p className="text-muted-foreground text-sm">
						This layer reproduces the camera solved on its source clip; it draws nothing.
					</p>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
