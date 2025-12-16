import { appDataDir, resolve } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { info } from "@tauri-apps/plugin-log";

export interface FavoriteGame {
  gameId: string;
  gameType: "local" | "chesscom" | "lichess";
  timestamp: number; // When it was favorited
}

const FILENAME = "favorite_games.json";

export async function saveFavoriteGame(gameId: string, gameType: "local" | "chesscom" | "lichess"): Promise<void> {
  try {
    const dir = await appDataDir();
    info(`[favoriteGames] Saving favorite game to directory: ${dir}`);

    // Ensure directory exists
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
      info(`[favoriteGames] Created directory: ${dir}`);
    }

    const file = await resolve(dir, FILENAME);
    info(`[favoriteGames] Favorite games file path: ${file}`);

    let favorites: FavoriteGame[] = [];
    try {
      if (await exists(file)) {
        const text = await readTextFile(file);
        favorites = JSON.parse(text);
        info(`[favoriteGames] Loaded ${favorites.length} existing favorite games`);
      } else {
        info(`[favoriteGames] Favorite games file does not exist, creating new one`);
      }
    } catch (err) {
      info(`[favoriteGames] Failed to read existing favorite games: ${err}`);
      // Continue with empty array
    }

    // Check if already favorited
    const existingIndex = favorites.findIndex((f) => f.gameId === gameId && f.gameType === gameType);
    if (existingIndex === -1) {
      favorites.push({
        gameId,
        gameType,
        timestamp: Date.now(),
      });
      info(`[favoriteGames] Added favorite game: ${gameId} (${gameType})`);
    } else {
      info(`[favoriteGames] Game already favorited: ${gameId} (${gameType})`);
      return;
    }

    await writeTextFile(file, JSON.stringify(favorites, null, 2));
    info(`[favoriteGames] Successfully saved favorite games to ${file}`);

    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new Event("favorites:updated"));
        info(`[favoriteGames] Dispatched favorites:updated event`);
      } catch (err) {
        info(`[favoriteGames] Failed to dispatch favorites:updated event: ${err}`);
      }
    }
  } catch (err) {
    info(`[favoriteGames] Failed to save favorite game: ${err}`);
    throw err;
  }
}

export async function removeFavoriteGame(gameId: string, gameType: "local" | "chesscom" | "lichess"): Promise<void> {
  try {
    const dir = await appDataDir();
    const file = await resolve(dir, FILENAME);

    if (!(await exists(file))) {
      info(`[favoriteGames] Favorite games file does not exist`);
      return;
    }

    const text = await readTextFile(file);
    const favorites: FavoriteGame[] = JSON.parse(text);

    const filtered = favorites.filter((f) => !(f.gameId === gameId && f.gameType === gameType));
    info(`[favoriteGames] Removed favorite game: ${gameId} (${gameType})`);

    await writeTextFile(file, JSON.stringify(filtered, null, 2));
    info(`[favoriteGames] Successfully saved favorite games to ${file}`);

    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new Event("favorites:updated"));
        info(`[favoriteGames] Dispatched favorites:updated event`);
      } catch (err) {
        info(`[favoriteGames] Failed to dispatch favorites:updated event: ${err}`);
      }
    }
  } catch (err) {
    info(`[favoriteGames] Failed to remove favorite game: ${err}`);
    throw err;
  }
}

export async function getAllFavoriteGames(): Promise<FavoriteGame[]> {
  try {
    const dir = await appDataDir();
    const file = await resolve(dir, FILENAME);

    if (!(await exists(file))) {
      info(`[favoriteGames] Favorite games file does not exist`);
      return [];
    }

    const text = await readTextFile(file);
    const favorites: FavoriteGame[] = JSON.parse(text);
    info(`[favoriteGames] Loaded ${favorites.length} favorite games`);

    return favorites;
  } catch (err) {
    info(`[favoriteGames] Failed to load favorite games: ${err}`);
    return [];
  }
}

export async function isFavoriteGame(gameId: string, gameType: "local" | "chesscom" | "lichess"): Promise<boolean> {
  try {
    const favorites = await getAllFavoriteGames();
    return favorites.some((f) => f.gameId === gameId && f.gameType === gameType);
  } catch (err) {
    info(`[favoriteGames] Failed to check if game is favorite: ${err}`);
    return false;
  }
}

