"use client";

import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { NumberParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type { NumberParamDefinition, ParamValue } from "@/params";
import type { CameraTrackerSettings } from "@/tracking/camera3d/types";
import { TARGET_SIZE_RANGE } from "@/tracking/camera3d/ui/target";
import {
	ANGLE_OF_VIEW_RANGE,
	SHOT_TYPE_OPTIONS,
	SOLVE_METHOD_OPTIONS,
	TRACK_POINT_DISPLAY_OPTIONS,
	TRACK_POINT_SIZE_RANGE,
	TRACKING_TAB_DESCRIPTION,
	type Availability,
	type TrackingTabModel,
} from "@/tracking/camera3d/ui/tab-model";

type SettingKey = keyof CameraTrackerSettings;
type SelectKey = "shotType" | "showTrackPoints" | "solveMethod";
type NumberKey = "horizontalAngleOfViewDeg" | "trackPointSize" | "targetSize";
type SwitchKey =
	| "renderTrackPoints"
	| "detailedAnalysis"
	| "autoDeleteAcrossTime"
	| "hideWarningBanner";

/** AE's effect controls; numbers reuse the property bars so they look like every other field. */
const SELECTS: Record<
	SelectKey,
	{ label: string; options: ReadonlyArray<{ value: string; label: string }> }
> = {
	shotType: { label: "Shot Type", options: SHOT_TYPE_OPTIONS },
	showTrackPoints: { label: "Show Track Points", options: TRACK_POINT_DISPLAY_OPTIONS },
	solveMethod: { label: "Solve Method", options: SOLVE_METHOD_OPTIONS },
};

const NUMBERS: Record<NumberKey, NumberParamDefinition> = {
	horizontalAngleOfViewDeg: {
		key: "horizontalAngleOfViewDeg",
		label: "Horizontal Angle of View",
		type: "number",
		default: 60,
		keyframable: false,
		min: ANGLE_OF_VIEW_RANGE.min,
		max: ANGLE_OF_VIEW_RANGE.max,
		step: 0.1,
		unitLabel: "degrees",
	},
	trackPointSize: {
		key: "trackPointSize",
		label: "Track Point Size",
		type: "number",
		default: 100,
		keyframable: false,
		min: TRACK_POINT_SIZE_RANGE.min,
		max: TRACK_POINT_SIZE_RANGE.max,
		step: 1,
		unitLabel: "percent",
	},
	targetSize: {
		key: "targetSize",
		label: "Target Size",
		type: "number",
		default: 100,
		keyframable: false,
		min: TARGET_SIZE_RANGE.min,
		max: TARGET_SIZE_RANGE.max,
		step: 1,
		slider: { min: TARGET_SIZE_RANGE.min, max: 400 },
		unitLabel: "percent",
	},
};

const SWITCHES: Record<SwitchKey, string> = {
	renderTrackPoints: "Render Track Points",
	detailedAnalysis: "Detailed Analysis",
	autoDeleteAcrossTime: "Auto-delete Points Across Time",
	hideWarningBanner: "Hide Warning Banner",
};

export interface CameraTrackerTabViewProps {
	elementId: string;
	model: TrackingTabModel;
	/** Settings shown in the fields (the stored ones with the value being dragged on top). */
	values: CameraTrackerSettings;
	onPrimary: () => void;
	onStaleAction: () => void;
	onCreateCamera: () => void;
	onSettingPreview: (args: { key: SettingKey; value: ParamValue }) => void;
	onSettingCommit: () => void;
}

/** A labelled switch row (the label is the switch's accessible name and toggles it). */
function SwitchRow({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	const id = useId();
	return (
		<div className="flex items-center justify-between gap-2">
			<Label htmlFor={id} className="text-foreground text-sm font-normal">
				{label}
			</Label>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</div>
	);
}

/** A button that stays focusable when unavailable and says why (like the other tracking buttons). */
function ReasonButton({
	availability,
	variant,
	onClick,
	children,
}: {
	availability: Availability;
	variant: "secondary" | "outline";
	onClick: () => void;
	children: ReactNode;
}) {
	const reasonId = useId();
	return (
		<>
			<Button
				variant={variant}
				aria-disabled={!availability.enabled}
				aria-describedby={availability.reason ? reasonId : undefined}
				size="sm"
				className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
				onClick={() => {
					if (availability.enabled) onClick();
				}}
			>
				{children}
			</Button>
			{availability.reason ? (
				<p id={reasonId} className="text-muted-foreground -mt-1.5 text-xs">
					{availability.reason}
				</p>
			) : null}
		</>
	);
}

/** The video clip's Tracking tab as plain markup of a {@link TrackingTabModel}: no store, no editor. */
export function CameraTrackerTabView({
	elementId,
	model,
	values,
	onPrimary,
	onStaleAction,
	onCreateCamera,
	onSettingPreview,
	onSettingCommit,
}: CameraTrackerTabViewProps) {
	const controlsReasonId = useId();
	const locked = !model.controls.enabled;
	const change = ({ key, value }: { key: SettingKey; value: ParamValue }) => {
		if (locked) return;
		onSettingPreview({ key, value });
		onSettingCommit();
	};
	const selectField = (key: SelectKey) => (
		<SectionField key={key} label={SELECTS[key].label}>
			<Select value={values[key]} onValueChange={(value) => change({ key, value })}>
				<SelectTrigger className="w-full" aria-label={SELECTS[key].label}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{SELECTS[key].options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SectionField>
	);
	const numberField = (key: NumberKey) => (
		<SectionField key={key} label={NUMBERS[key].label}>
			<NumberParamField
				param={NUMBERS[key]}
				value={values[key]}
				onPreview={(value) => {
					if (!locked) onSettingPreview({ key, value });
				}}
				onCommit={() => {
					if (!locked) onSettingCommit();
				}}
			/>
		</SectionField>
	);
	const switchField = (key: SwitchKey) => (
		<SwitchRow
			key={key}
			label={SWITCHES[key]}
			checked={values[key]}
			onChange={(value) => change({ key, value })}
		/>
	);
	// locked controls are inert (not focusable, not clickable) and say why
	const group = {
		inert: locked,
		"aria-disabled": locked,
		"aria-describedby": model.controls.reason ? controlsReasonId : undefined,
		className: locked ? "flex flex-col gap-3.5 opacity-50" : "flex flex-col gap-3.5",
	};

	return (
		<>
			<Section sectionKey={`${elementId}:camera-tracker`}>
				<SectionHeader>
					<SectionTitle className="text-foreground">Track Camera</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<p className="text-muted-foreground text-xs leading-relaxed">{TRACKING_TAB_DESCRIPTION}</p>
						<ReasonButton
							availability={model.primary}
							variant={model.primary.label === "Track Camera" ? "secondary" : "outline"}
							onClick={onPrimary}
						>
							{model.primary.label}
						</ReasonButton>
						{model.progress ? (
							<div className="flex flex-col gap-1.5">
								<Progress value={model.progress.percent} aria-label="Track Camera progress" />
								<p className="text-sm">{model.progress.text}</p>
							</div>
						) : null}
						{model.summary ? (
							<p className="text-sm">
								<span className="text-muted-foreground">Solved: </span>
								{model.summary}
							</p>
						) : null}
						{model.failure ? (
							<p className="border-destructive/45 text-destructive rounded-sm border px-2.5 py-2 text-sm">
								{model.failure}
							</p>
						) : null}
						{model.stale ? (
							<div className="border-caution/40 text-caution flex items-center justify-between gap-2 rounded-sm border px-2.5 py-2 text-sm">
								<span>{model.stale.text}</span>
								<Button
									variant="outline"
									size="sm"
									aria-disabled={!model.stale.enabled}
									className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
									onClick={() => {
										if (model.stale?.enabled) onStaleAction();
									}}
								>
									{model.stale.actionLabel}
								</Button>
							</div>
						) : null}
						{model.notices.map((notice) => (
							<p key={notice} className="border-caution/40 text-caution rounded-sm border px-2.5 py-2 text-sm">
								{notice}
							</p>
						))}
						{model.controls.reason ? (
							<p id={controlsReasonId} className="text-muted-foreground text-xs">
								{model.controls.reason}
							</p>
						) : null}
						<div {...group}>
							{selectField("shotType")}
							{model.showAngleOfView ? numberField("horizontalAngleOfViewDeg") : null}
							{selectField("showTrackPoints")}
							{switchField("renderTrackPoints")}
							{numberField("trackPointSize")}
							{numberField("targetSize")}
						</div>
						<ReasonButton availability={model.createCamera} variant="outline" onClick={onCreateCamera}>
							Create Camera
						</ReasonButton>
					</SectionFields>
				</SectionContent>
			</Section>
			<Section sectionKey={`${elementId}:camera-tracker-advanced`} collapsible defaultOpen={false}>
				<SectionHeader>
					<SectionTitle>Advanced</SectionTitle>
				</SectionHeader>
				<SectionContent>
					<SectionFields>
						<div {...group}>{selectField("solveMethod")}</div>
						<dl className="flex flex-col gap-2 text-sm">
							<div className="flex justify-between gap-2">
								<dt className="text-muted-foreground">Method Used</dt>
								<dd>{model.methodUsed ?? "Not solved"}</dd>
							</div>
							<div className="flex justify-between gap-2">
								<dt className="text-muted-foreground">Average Error</dt>
								<dd>{model.averageError ?? "Not solved"}</dd>
							</div>
						</dl>
						<div {...group}>
							{switchField("detailedAnalysis")}
							{switchField("autoDeleteAcrossTime")}
							{switchField("hideWarningBanner")}
						</div>
					</SectionFields>
				</SectionContent>
			</Section>
		</>
	);
}
