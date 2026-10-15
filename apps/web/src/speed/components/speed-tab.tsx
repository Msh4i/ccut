import { useRef } from "react";
import { useEditor } from "@/editor/use-editor";
import { SliderField } from "@/components/ui/slider-field";
import { Switch } from "@/components/ui/switch";
import { HugeiconsIcon } from "@hugeicons/react";
import { DashboardSpeed02Icon } from "@hugeicons/core-free-icons";
import { buildConstantRetime } from "@/retime";
import type { NumberSliderSpec } from "@/params/slider";
import {
	DEFAULT_RETIME_RATE,
	MIN_RETIME_RATE,
	MAX_RETIME_RATE,
	clampRetimeRate,
	canMaintainPitch,
} from "@/retime/rate";
import type { AudioElement, VideoElement } from "@/timeline";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import {
	formatNumberForDisplay,
	getFractionDigitsForStep,
	snapToStep,
} from "@/utils/math";

const SPEED_STEP = 0.01;
const SPEED_FRACTION_DIGITS = getFractionDigitsForStep({ step: SPEED_STEP });
const SPEED_SLIDER: NumberSliderSpec = {
	min: MIN_RETIME_RATE,
	max: MAX_RETIME_RATE,
	pivot: DEFAULT_RETIME_RATE,
};

function rateToDisplay({ rate }: { rate: number }): string {
	return formatNumberForDisplay({
		value: rate,
		fractionDigits: SPEED_FRACTION_DIGITS,
	});
}

function parseSpeedInput({ input }: { input: string }): number | null {
	const parsed = parseFloat(input);
	if (Number.isNaN(parsed)) return null;
	return clampRetimeRate({
		rate: snapToStep({ value: parsed, step: SPEED_STEP }),
	});
}

function buildRetime({
	rate,
	maintainPitch,
}: {
	rate: number;
	maintainPitch: boolean;
}) {
	if (rate === DEFAULT_RETIME_RATE && !maintainPitch) return undefined;
	return buildConstantRetime({ rate, maintainPitch });
}

export function SpeedTab({
	element,
	trackId,
}: {
	element: AudioElement | VideoElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { renderElement, previewUpdates } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});
	const rate = clampRetimeRate({
		rate: renderElement.retime?.rate ?? DEFAULT_RETIME_RATE,
	});
	const isPitchPreserveAvailable = canMaintainPitch({ rate });
	const maintainPitch = renderElement.retime?.maintainPitch ?? false;
	const pendingRateRef = useRef(rate);

	const commitRetime = ({
		rate: nextRate,
		maintainPitch: nextMaintainPitch,
	}: {
		rate: number;
		maintainPitch: boolean;
	}) => {
		editor.timeline.updateElementRetime({
			trackId,
			elementId: element.id,
			retime: buildRetime({ rate: nextRate, maintainPitch: nextMaintainPitch }),
		});
	};

	const previewRate = (nextRate: number) => {
		pendingRateRef.current = nextRate;
		// Not buildRetime: that drops the retime at exactly 1x, and a preview of
		// undefined equals the overlay's absent value, so it would be ignored.
		previewUpdates({
			retime: buildConstantRetime({ rate: nextRate, maintainPitch }),
		});
	};
	const commitPendingRate = () =>
		commitRetime({ rate: pendingRateRef.current, maintainPitch });
	const resetRate = () =>
		commitRetime({ rate: DEFAULT_RETIME_RATE, maintainPitch });

	const speedDraft = usePropertyDraft({
		displayValue: rateToDisplay({ rate }),
		parse: (input) => parseSpeedInput({ input }),
		onPreview: previewRate,
		onCommit: commitPendingRate,
	});

	return (
		<Section collapsible sectionKey={`${element.id}:speed`}>
			<SectionHeader>
				<SectionTitle>Speed</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<SectionField label="Speed">
						<SliderField
							value={rate}
							slider={SPEED_SLIDER}
							step={SPEED_STEP}
							label="Speed"
							unit="x"
							onPreview={previewRate}
							onCommit={commitPendingRate}
							onReset={resetRate}
							fieldProps={{
								icon: <HugeiconsIcon icon={DashboardSpeed02Icon} />,
								value: speedDraft.displayValue,
								suffix: "x",
								onFocus: () => {
									pendingRateRef.current = rate;
									speedDraft.onFocus();
								},
								onChange: speedDraft.onChange,
								onBlur: speedDraft.onBlur,
								onReset: resetRate,
								isDefault: rate === DEFAULT_RETIME_RATE,
							}}
						/>
					</SectionField>
					<div className="flex items-center justify-between">
						<span className="text-sm">Change pitch</span>
						<Switch
							checked={!maintainPitch}
							disabled={!isPitchPreserveAvailable}
							onCheckedChange={(checked) =>
								commitRetime({ rate, maintainPitch: !checked })
							}
						/>
					</div>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
