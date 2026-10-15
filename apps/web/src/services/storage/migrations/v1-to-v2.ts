import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import type { MediaAssetData } from "@/services/storage/types";
import { StorageMigration, type StorageMigrationRunArgs } from "./base";
import type { MigrationResult, ProjectRecord } from "./transformers/types";
import {
	transformProjectV1ToV2,
	type V1ToV2Context,
} from "./transformers/v1-to-v2";
import { isRecord } from "./transformers/utils";

interface LegacyTimelineData {
	tracks: unknown[];
	lastModified: string;
}

export class V1toV2Migration extends StorageMigration {
	from = 1;
	to = 2;

	async run({
		projectId,
		project,
	}: StorageMigrationRunArgs): Promise<MigrationResult<ProjectRecord>> {
		// Legacy timeline DBs are kept: migrations are additive only (see AGENTS.md).
		const context = await loadV1ToV2Context({ projectId, project });
		return transformProjectV1ToV2({ project, context });
	}
}

async function loadV1ToV2Context({
	projectId,
	project,
}: {
	projectId: string;
	project: ProjectRecord;
}): Promise<V1ToV2Context> {
	const legacyTracksBySceneId = await loadLegacyTracksBySceneId({
		projectId,
		project,
	});
	const mediaTypesById = await loadMediaTypesById({
		projectId,
		legacyTracksBySceneId,
	});

	return {
		legacyTracksBySceneId,
		mediaTypesById,
	};
}

async function loadLegacyTracksBySceneId({
	projectId,
	project,
}: {
	projectId: string;
	project: ProjectRecord;
}): Promise<V1ToV2Context["legacyTracksBySceneId"]> {
	const scenes = project.scenes;
	if (!Array.isArray(scenes)) {
		return {};
	}

	const sceneEntries = await Promise.all(
		scenes.map(async (scene) => {
			if (!isRecord(scene)) {
				return null;
			}

			const sceneId = scene.id;
			if (typeof sceneId !== "string") {
				return null;
			}

			const tracks = await loadLegacyTracksForScene({
				projectId,
				sceneId,
				isMain: scene.isMain === true,
			});

			return [sceneId, tracks] as const;
		}),
	);

	return Object.fromEntries(
		sceneEntries.filter(
			(
				sceneEntry,
			): sceneEntry is readonly [
				string,
				V1ToV2Context["legacyTracksBySceneId"][string],
			] => sceneEntry !== null,
		),
	);
}

async function loadLegacyTracksForScene({
	projectId,
	sceneId,
	isMain,
}: {
	projectId: string;
	sceneId: string;
	isMain: boolean;
}): Promise<unknown[]> {
	const sceneDbName = `video-editor-timelines-${projectId}-${sceneId}`;
	const projectDbName = `video-editor-timelines-${projectId}`;

	const adapter = new IndexedDBAdapter<LegacyTimelineData>({
		dbName: sceneDbName,
		storeName: "timeline",
		version: 1,
	});

	let data = await adapter.get("timeline");

	if (!data && isMain) {
		const projectAdapter = new IndexedDBAdapter<LegacyTimelineData>({
			dbName: projectDbName,
			storeName: "timeline",
			version: 1,
		});
		data = await projectAdapter.get("timeline");
	}

	if (!data || !Array.isArray(data.tracks)) {
		return [];
	}

	return data.tracks;
}

async function loadMediaTypesById({
	projectId,
	legacyTracksBySceneId,
}: {
	projectId: string;
	legacyTracksBySceneId: V1ToV2Context["legacyTracksBySceneId"];
}): Promise<V1ToV2Context["mediaTypesById"]> {
	const mediaIds = collectLegacyMediaIds({ legacyTracksBySceneId });
	if (mediaIds.length === 0) {
		return {};
	}

	const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
		dbName: `video-editor-media-${projectId}`,
		storeName: "media-metadata",
		version: 1,
	});

	const mediaEntries = await Promise.all(
		mediaIds.map(async (mediaId) => {
			const mediaMetadata = await mediaMetadataAdapter.get(mediaId);
			if (!mediaMetadata) {
				return null;
			}

			return [mediaId, mediaMetadata.type] as const;
		}),
	);

	return Object.fromEntries(
		mediaEntries.filter(
			(
				mediaEntry,
			): mediaEntry is readonly [
				string,
				V1ToV2Context["mediaTypesById"][string],
			] => mediaEntry !== null,
		),
	);
}

function collectLegacyMediaIds({
	legacyTracksBySceneId,
}: {
	legacyTracksBySceneId: V1ToV2Context["legacyTracksBySceneId"];
}): string[] {
	const mediaIds = new Set<string>();

	for (const tracks of Object.values(legacyTracksBySceneId)) {
		if (!Array.isArray(tracks)) {
			continue;
		}

		for (const track of tracks) {
			if (!isRecord(track) || track.type !== "media") {
				continue;
			}

			const elements = track.elements;
			if (!Array.isArray(elements)) {
				continue;
			}

			for (const element of elements) {
				if (!isRecord(element) || element.type !== "media") {
					continue;
				}

				if (typeof element.mediaId !== "string") {
					continue;
				}

				mediaIds.add(element.mediaId);
			}
		}
	}

	return Array.from(mediaIds);
}
