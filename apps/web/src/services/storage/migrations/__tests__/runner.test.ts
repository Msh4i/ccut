import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import {
	CURRENT_PROJECT_VERSION,
	migrations,
	runStorageMigrations,
	StorageMigration,
	type MigrationProgress,
} from "@/services/storage/migrations";
import type { StorageMigrationRunArgs } from "@/services/storage/migrations/base";
import type {
	MigrationResult,
	ProjectRecord,
} from "@/services/storage/migrations/transformers/types";
import {
	v0Project,
	v0ProjectEmpty,
	v0ProjectWithMetadata,
	v1Project,
	v1ProjectWithMultipleScenes,
	v2Project,
	v2ProjectEmptyScenes,
	v2ProjectSceneWithoutTracks,
	v2ProjectWithBlurBackground,
	v3Project,
	v5Project,
} from "./fixtures";
import { asRecord } from "./helpers";

const IDLE_PROGRESS: MigrationProgress = {
	isMigrating: false,
	fromVersion: null,
	toVersion: null,
	projectName: null,
};

function createProjectsAdapter() {
	return new IndexedDBAdapter<ProjectRecord>({
		dbName: "video-editor-projects",
		storeName: "projects",
		version: 1,
	});
}

function stepMigration({
	fromVersion,
	run,
}: {
	fromVersion: number;
	run?: (args: StorageMigrationRunArgs) => MigrationResult<ProjectRecord>;
}): StorageMigration {
	return new (class extends StorageMigration {
		from = fromVersion;
		to = fromVersion + 1;

		async run(
			args: StorageMigrationRunArgs,
		): Promise<MigrationResult<ProjectRecord>> {
			return (
				run?.(args) ?? {
					project: { ...args.project, version: this.to },
					skipped: false,
				}
			);
		}
	})();
}

// A broken or populated factory must not leak into the next test file.
afterAll(() => {
	globalThis.indexedDB = new IDBFactory();
});

describe("migration chain", () => {
	test("has one step per version from 0, without gaps or overlaps", () => {
		expect(migrations.map(({ from, to }) => [from, to])).toEqual(
			Array.from({ length: migrations.length }, (_, index) => [
				index,
				index + 1,
			]),
		);
	});

	test("CURRENT_PROJECT_VERSION is the target of the last migration", () => {
		expect(migrations.at(-1)?.to).toBe(CURRENT_PROJECT_VERSION);
	});
});

describe("runStorageMigrations with real project fixtures", () => {
	// startVersion: what getProjectVersion derives (explicit version, else 1 when
	// scenes exist, else 0).
	const cases = [
		{ fixture: v0Project, startVersion: 0, name: "My V0 Project" },
		{
			fixture: v0ProjectWithMetadata,
			startVersion: 0,
			name: "V0 With Metadata",
		},
		{ fixture: v0ProjectEmpty, startVersion: 0, name: "Empty Project" },
		{ fixture: v1Project, startVersion: 1, name: "My V1 Project" },
		{
			fixture: v1ProjectWithMultipleScenes,
			startVersion: 1,
			name: "Multi-Scene Project",
		},
		{ fixture: v2Project, startVersion: 2, name: "My V2 Project" },
		{
			fixture: v2ProjectWithBlurBackground,
			startVersion: 2,
			name: "Blur Background Project",
		},
		{
			fixture: v2ProjectEmptyScenes,
			startVersion: 2,
			name: "Empty Scenes Project",
		},
		{
			fixture: v2ProjectSceneWithoutTracks,
			startVersion: 2,
			name: "Scene Without Tracks",
		},
		{ fixture: v3Project, startVersion: 3, name: "My V3 Project" },
		{ fixture: v5Project, startVersion: 5, name: "My V5 Project" },
	];

	const progress: MigrationProgress[] = [];
	let firstRun: { migratedCount: number };
	let secondRun: { migratedCount: number };
	let afterSecondRun: ProjectRecord[];
	const migrated = new Map<string, ProjectRecord>();

	// The runner keeps the progress dialog open for at least 1 s whenever it
	// migrates something, so run it once and let the tests only read.
	beforeAll(async () => {
		globalThis.indexedDB = new IDBFactory();
		const adapter = createProjectsAdapter();
		for (const { fixture } of cases) {
			await adapter.set({ key: fixture.id, value: fixture });
		}

		firstRun = await runStorageMigrations({
			migrations,
			onProgress: (event) => progress.push(event),
		});
		for (const { fixture } of cases) {
			const stored = await adapter.get(fixture.id);
			if (stored) migrated.set(fixture.id, stored);
		}
		secondRun = await runStorageMigrations({ migrations });
		afterSecondRun = await adapter.getAll();
	});

	test("brings every project to CURRENT_PROJECT_VERSION", () => {
		for (const { fixture } of cases) {
			expect([fixture.id, migrated.get(fixture.id)?.version]).toEqual([
				fixture.id,
				CURRENT_PROJECT_VERSION,
			]);
		}
	});

	test("counts one step per version crossed, none skipped", () => {
		const expectedSteps = cases.reduce(
			(total, { startVersion }) =>
				total + CURRENT_PROJECT_VERSION - startVersion,
			0,
		);

		expect(firstRun.migratedCount).toBe(expectedSteps);
	});

	test("a second run has nothing left to migrate and rewrites nothing", () => {
		expect(secondRun.migratedCount).toBe(0);
		expect(afterSecondRun).toHaveLength(cases.length);
		for (const record of afterSecondRun) {
			expect(record).toEqual(asRecord(migrated.get(String(record.id))));
		}
	});

	test("is additive: every original top-level field survives and names are kept", () => {
		for (const { fixture, name } of cases) {
			const record = asRecord(migrated.get(fixture.id));

			expect(Object.keys(fixture).filter((key) => !(key in record))).toEqual(
				[],
			);
			expect(asRecord(record.metadata).name).toBe(name);
		}
	});

	test("reports progress per project and finishes with an idle event", () => {
		const active = progress.filter((event) => event.isMigrating);

		expect(active).toHaveLength(cases.length);
		for (const event of active) {
			expect(event.toVersion).toBe(CURRENT_PROJECT_VERSION);
			expect(typeof event.fromVersion).toBe("number");
			expect(typeof event.projectName).toBe("string");
		}
		expect(progress.at(-1)).toEqual(IDLE_PROGRESS);
	});
});

describe("runStorageMigrations edge cases", () => {
	beforeEach(() => {
		globalThis.indexedDB = new IDBFactory();
	});

	// Restores spies even when an assertion throws. Bun hands out the SAME mock
	// when a method is spied twice, so a spy left behind would also count the
	// calls of every later test.
	afterEach(() => {
		mock.restore();
	});

	test("a failing migration stops only its own project at the last saved version", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		const adapter = createProjectsAdapter();
		await adapter.set({ key: "healthy", value: { version: 0 } });
		await adapter.set({ key: "broken", value: { version: 0 } });

		const result = await runStorageMigrations({
			migrations: [
				stepMigration({ fromVersion: 0 }),
				stepMigration({
					fromVersion: 1,
					run: ({ projectId, project }) => {
						if (projectId === "broken") throw new Error("corrupt scene");
						return { project: { ...project, version: 2 }, skipped: false };
					},
				}),
			],
		});

		expect((await adapter.get("healthy"))?.version).toBe(2);
		expect((await adapter.get("broken"))?.version).toBe(1);
		expect(result.migratedCount).toBe(3);
		// Only this runner's own message counts. bun runs every test file in one
		// process, so console.error calls from other files' leftover async work
		// (timers, retry loops) can land inside this test's ~1 s window.
		const migrationFailures = consoleError.mock.calls.filter(
			([message]) =>
				typeof message === "string" &&
				message.startsWith("Storage migration failed for project"),
		);
		expect(migrationFailures).toHaveLength(1);
		expect(migrationFailures[0]?.[0]).toContain("project broken at v1");
	});

	test("a skipped migration leaves the stored project untouched", async () => {
		const adapter = createProjectsAdapter();
		await adapter.set({ key: "p", value: { version: 0, keep: "me" } });

		const result = await runStorageMigrations({
			migrations: [
				stepMigration({
					fromVersion: 0,
					run: ({ project }) => ({ project, skipped: true }),
				}),
			],
		});

		expect(result.migratedCount).toBe(0);
		expect(await adapter.get("p")).toEqual({ id: "p", version: 0, keep: "me" });
	});

	test("leaves projects saved by a newer app version untouched", async () => {
		const adapter = createProjectsAdapter();
		await adapter.set({ key: "future", value: { version: 99, extra: true } });

		const result = await runStorageMigrations({ migrations });

		expect(result.migratedCount).toBe(0);
		expect(await adapter.get("future")).toEqual({
			id: "future",
			version: 99,
			extra: true,
		});
	});

	test("reports only the idle event when there is nothing to migrate", async () => {
		const events: MigrationProgress[] = [];

		await runStorageMigrations({
			migrations,
			onProgress: (event) => events.push(event),
		});

		expect(events).toEqual([IDLE_PROGRESS]);
	});

	test("rejects with the storage error but still reports the idle event", async () => {
		class BrokenFactory extends IDBFactory {
			override open(): never {
				throw new Error("storage unavailable");
			}
		}
		globalThis.indexedDB = new BrokenFactory();
		const events: MigrationProgress[] = [];

		await expect(
			runStorageMigrations({
				migrations,
				onProgress: (event) => events.push(event),
			}),
		).rejects.toThrow("storage unavailable");

		expect(events).toEqual([IDLE_PROGRESS]);
	});
});
