// The harness's guards around the owner's data (perf-two-clips.js): the app is started only on the
// harness's own temporary directory, a profile is copied without following any link out of it, and
// only the harness's own temporary directories are deleted. File access and the launch are injected.
const path = require("node:path");
const { isSafeUserDataDir, shouldCopyProfileEntry } = require("./args");

class HarnessError extends Error {}

/**
 * Copies the user-data dir `from` into `to` (a fresh temporary directory). The source is resolved
 * first (a link TO the profile is fine); inside it every entry is checked with lstat and a symlink
 * stops the copy: following an absolute or "../" link would let the harness write into the live
 * store through the copy. Chromium's single-instance files and DevToolsActivePort are not copied.
 */
function copyProfile({ fs, from, to }) {
	let source;
	try {
		source = fs.realpathSync(from);
	} catch (error) {
		throw new HarnessError(`--profile-copy ${from}: ${error.message}`);
	}
	if (!fs.statSync(source).isDirectory()) throw new HarnessError(`--profile-copy ${source} is not a directory`);
	const notes = [];
	try {
		fs.lstatSync(path.join(source, "SingletonLock"));
		notes.push("the copied profile has a SingletonLock: Ccut may have been running on it, the copy can be inconsistent (close Ccut or copy a backup)");
	} catch {
		// no lock: Ccut is not running on it
	}
	fs.cpSync(source, to, {
		recursive: true,
		filter: (entry) => {
			if (entry === source) return true;
			if (!shouldCopyProfileEntry(path.basename(entry))) return false;
			if (fs.lstatSync(entry).isSymbolicLink()) {
				throw new HarnessError(`the profile contains a symlink at ${path.relative(source, entry)}: copy a real backup (the harness never follows links out of a profile)`);
			}
			return true;
		},
	});
	return { source, notes };
}

/** Starts the app only on a ccut-perf-* directory directly in the temp root. */
async function launchGuarded({ userDataDir, tmpRoot, launch }) {
	if (!isSafeUserDataDir({ dir: userDataDir, tmpRoot })) throw new HarnessError(`refusing to start the app on ${userDataDir}: not a ccut-perf-* temporary directory`);
	return launch({ userDataDir });
}

/** Deletes the given directories that are ccut-perf-* directories directly in the temp root; never anything else. */
function removeTempDirs({ dirs, tmpRoot, fs, log }) {
	const result = { removed: 0, refused: 0, failed: 0 };
	for (const dir of dirs) {
		if (!isSafeUserDataDir({ dir, tmpRoot })) {
			result.refused += 1;
			log(`not deleting ${dir}: not a ccut-perf-* temporary directory`);
			continue;
		}
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			result.removed += 1;
		} catch (error) {
			result.failed += 1;
			log(`could not delete ${dir}: ${error.message}`);
		}
	}
	return result;
}

module.exports = { HarnessError, copyProfile, launchGuarded, removeTempDirs };
