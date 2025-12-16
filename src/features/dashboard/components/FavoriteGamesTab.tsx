import { ActionIcon, Avatar, Badge, Button, Group, Pagination, ScrollArea, Stack, Table, Text } from "@mantine/core";
import { IconStarFilled } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnalysisPreview } from "@/components/AnalysisPreview";
import { currentThemeIdAtom } from "@/features/themes/state/themeAtoms";
import { getAnalyzedGame, getGameStats as getSavedGameStats } from "@/utils/analyzedGames";
import type { ChessComGame } from "@/utils/chess.com/api";
import type { GameRecord } from "@/utils/gameRecords";
import type { FavoriteGame } from "@/utils/favoriteGames";
import { createChessComGameHeaders, createLichessGameHeaders, createLocalGameHeaders } from "../utils/gameHelpers";

interface LichessGame {
  id: string;
  players: {
    white: { user?: { name: string } };
    black: { user?: { name: string } };
  };
  speed: string;
  createdAt: number;
  winner?: string;
  status: string;
  pgn?: string;
  lastFen: string;
}

interface FavoriteGamesTabProps {
  localGames: GameRecord[];
  chessComGames: ChessComGame[];
  lichessGames: LichessGame[];
  favoriteGames: FavoriteGame[];
  chessComUsernames: string[];
  lichessUsernames: string[];
  onAnalyzeLocalGame: (game: GameRecord) => void;
  onAnalyzeChessComGame: (game: ChessComGame) => void;
  onAnalyzeLichessGame: (game: LichessGame) => void;
  onToggleFavoriteLocal?: (gameId: string) => Promise<void>;
  onToggleFavoriteChessCom?: (gameId: string) => Promise<void>;
  onToggleFavoriteLichess?: (gameId: string) => Promise<void>;
}

interface FavoriteGameItem {
  id: string;
  type: "local" | "chesscom" | "lichess";
  game: GameRecord | ChessComGame | LichessGame;
  timestamp: number;
}

export function FavoriteGamesTab({
  localGames,
  chessComGames,
  lichessGames,
  favoriteGames,
  chessComUsernames,
  lichessUsernames,
  onAnalyzeLocalGame,
  onAnalyzeChessComGame,
  onAnalyzeLichessGame,
  onToggleFavoriteLocal,
  onToggleFavoriteChessCom,
  onToggleFavoriteLichess,
}: FavoriteGamesTabProps) {
  const { t } = useTranslation();
  const currentThemeId = useAtomValue(currentThemeIdAtom);
  const isAcademiaMaya = currentThemeId === "academia-maya";
  const [page, setPage] = useState(1);
  const itemsPerPage = 25;
  const [analyzedPgns, setAnalyzedPgns] = useState<Map<string, string>>(new Map());
  const [gameStats, setGameStats] = useState<Map<string, { accuracy: number; acpl: number; estimatedElo?: number }>>(
    new Map(),
  );

  // Combine all favorite games
  const favoriteGameItems = useMemo(() => {
    const items: FavoriteGameItem[] = [];

    favoriteGames.forEach((fav) => {
      if (fav.gameType === "local") {
        const game = localGames.find((g) => g.id === fav.gameId);
        if (game) {
          items.push({ id: fav.gameId, type: "local", game, timestamp: fav.timestamp });
        }
      } else if (fav.gameType === "chesscom") {
        const game = chessComGames.find((g) => g.url === fav.gameId);
        if (game) {
          items.push({ id: fav.gameId, type: "chesscom", game, timestamp: fav.timestamp });
        }
      } else if (fav.gameType === "lichess") {
        const game = lichessGames.find((g) => g.id === fav.gameId);
        if (game) {
          items.push({ id: fav.gameId, type: "lichess", game, timestamp: fav.timestamp });
        }
      }
    });

    // Sort by timestamp (most recent first)
    items.sort((a, b) => b.timestamp - a.timestamp);

    return items;
  }, [favoriteGames, localGames, chessComGames, lichessGames]);

  // Load analyzed PGNs
  useEffect(() => {
    if (favoriteGameItems.length === 0) return;

    let cancelled = false;

    const loadAnalyzedPgns = async () => {
      const pgnMap = new Map<string, string>();

      for (const item of favoriteGameItems) {
        if (cancelled) break;

        try {
          let analyzedPgn: string | null = null;
          let gameId = "";

          if (item.type === "local") {
            gameId = item.id;
            analyzedPgn = await getAnalyzedGame(gameId);
            if (!analyzedPgn && (item.game as GameRecord).pgn) {
              analyzedPgn = (item.game as GameRecord).pgn;
            }
          } else if (item.type === "chesscom") {
            gameId = (item.game as ChessComGame).url;
            analyzedPgn = await getAnalyzedGame(gameId);
            if (!analyzedPgn && (item.game as ChessComGame).pgn) {
              analyzedPgn = (item.game as ChessComGame).pgn;
            }
          } else if (item.type === "lichess") {
            gameId = (item.game as LichessGame).id;
            analyzedPgn = await getAnalyzedGame(gameId);
            if (!analyzedPgn && (item.game as LichessGame).pgn) {
              analyzedPgn = (item.game as LichessGame).pgn;
            }
          }

          if (analyzedPgn) {
            pgnMap.set(item.id, analyzedPgn);
          }
        } catch {
          // Silently skip
        }

        if (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      if (!cancelled) {
        setAnalyzedPgns(pgnMap);
      }
    };

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        loadAnalyzedPgns().catch(() => {});
      }
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [favoriteGameItems]);

  // Load stats
  useEffect(() => {
    if (favoriteGameItems.length === 0) return;

    let cancelled = false;

    const loadStats = async () => {
      const statsMap = new Map<string, { accuracy: number; acpl: number; estimatedElo?: number }>();

      for (const item of favoriteGameItems) {
        if (cancelled) break;

        try {
          let gameId = "";
          if (item.type === "local") {
            gameId = item.id;
            const game = item.game as GameRecord;
            if (game.stats && game.stats.acpl > 0) {
              statsMap.set(item.id, game.stats);
            }
          } else if (item.type === "chesscom") {
            gameId = (item.game as ChessComGame).url;
            const savedStats = await getSavedGameStats(gameId);
            if (savedStats && savedStats.acpl > 0) {
              statsMap.set(item.id, savedStats);
            }
          } else if (item.type === "lichess") {
            gameId = (item.game as LichessGame).id;
            const savedStats = await getSavedGameStats(gameId);
            if (savedStats && savedStats.acpl > 0) {
              statsMap.set(item.id, savedStats);
            }
          }
        } catch {
          // Silently skip
        }

        if (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      if (!cancelled) {
        setGameStats(statsMap);
      }
    };

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        loadStats().catch(() => {});
      }
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [favoriteGameItems]);

  const paginatedGames = useMemo(() => {
    const start = (page - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    return favoriteGameItems.slice(start, end);
  }, [favoriteGameItems, page, itemsPerPage]);

  const totalPages = Math.ceil(favoriteGameItems.length / itemsPerPage);

  useEffect(() => {
    setPage(1);
  }, [favoriteGameItems.length]);

  const getMoveCount = (item: FavoriteGameItem): number => {
    if (item.type === "local") {
      return (item.game as GameRecord).moves.length;
    } else {
      const pgn = (item.game as ChessComGame | LichessGame).pgn;
      if (!pgn) return 0;
      try {
        const moves = pgn.match(/\d+\.\s+\S+/g) || [];
        return moves.length;
      } catch {
        return 0;
      }
    }
  };

  const handleToggleFavorite = async (item: FavoriteGameItem) => {
    if (item.type === "local" && onToggleFavoriteLocal) {
      await onToggleFavoriteLocal(item.id);
    } else if (item.type === "chesscom" && onToggleFavoriteChessCom) {
      await onToggleFavoriteChessCom(item.id);
    } else if (item.type === "lichess" && onToggleFavoriteLichess) {
      await onToggleFavoriteLichess(item.id);
    }
  };

  const handleAnalyze = (item: FavoriteGameItem) => {
    if (item.type === "local") {
      onAnalyzeLocalGame(item.game as GameRecord);
    } else if (item.type === "chesscom") {
      onAnalyzeChessComGame(item.game as ChessComGame);
    } else if (item.type === "lichess") {
      onAnalyzeLichessGame(item.game as LichessGame);
    }
  };

  if (favoriteGameItems.length === 0) {
    return (
      <Stack gap="xs" align="center" justify="center" style={{ minHeight: "200px" }}>
        <Text size="sm" c="dimmed">
          No favorite games yet. Click the star icon on any game to add it to favorites.
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="xs" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Type</Table.Th>
              <Table.Th>Opponent</Table.Th>
              <Table.Th>Color</Table.Th>
              <Table.Th>Result</Table.Th>
              <Table.Th>Accuracy</Table.Th>
              <Table.Th>ACPL</Table.Th>
              <Table.Th>Elo</Table.Th>
              <Table.Th>Moves</Table.Th>
              <Table.Th>Favorite</Table.Th>
              <Table.Th>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {paginatedGames.map((item) => {
              let opponent: { name?: string; username?: string };
              let color: string;
              let result: string;
              let resultColor: string;
              let accountName: string = "";

              if (item.type === "local") {
                const game = item.game as GameRecord;
                const isUserWhite = game.white.type === "human";
                opponent = isUserWhite ? game.black : game.white;
                color = isUserWhite ? t("chess.white") : t("chess.black");
                const userWon = (isUserWhite && game.result === "1-0") || (!isUserWhite && game.result === "0-1");
                result =
                  game.result === "1-0"
                    ? t("features.dashboard.win")
                    : game.result === "0-1"
                      ? t("features.dashboard.loss")
                      : game.result;
                resultColor = isAcademiaMaya
                  ? userWon
                    ? "green"
                    : game.result === "1-0" || game.result === "0-1"
                      ? "red"
                      : "gray"
                  : userWon
                    ? "teal"
                    : game.result === "1-0" || game.result === "0-1"
                      ? "red"
                      : "gray";
              } else if (item.type === "chesscom") {
                const game = item.game as ChessComGame;
                const accountUsername =
                  chessComUsernames.find(
                    (u) =>
                      u.toLowerCase() === game.white.username.toLowerCase() ||
                      u.toLowerCase() === game.black.username.toLowerCase(),
                  ) || game.white.username;
                const isUserWhite = game.white.username.toLowerCase() === accountUsername.toLowerCase();
                opponent = isUserWhite ? game.black : game.white;
                accountName = isUserWhite ? game.white.username : game.black.username;
                color = isUserWhite ? t("chess.white") : t("chess.black");
                const userResult = isUserWhite ? game.white.result : game.black.result;
                result =
                  userResult === "win"
                    ? t("features.dashboard.win")
                    : userResult === "checkmated" || userResult === "resigned" || userResult === "timeout"
                      ? t("features.dashboard.loss")
                      : t("chess.draw");
                resultColor = isAcademiaMaya
                  ? userResult === "win"
                    ? "green"
                    : userResult === "checkmated" || userResult === "resigned"
                      ? "red"
                      : "gray"
                  : userResult === "win"
                    ? "teal"
                    : userResult === "checkmated" || userResult === "resigned"
                      ? "red"
                      : "gray";
              } else {
                const game = item.game as LichessGame;
                const gameWhiteName = game.players.white.user?.name || "";
                const gameBlackName = game.players.black.user?.name || "";
                const accountUsername =
                  lichessUsernames.find(
                    (u) =>
                      u.toLowerCase() === gameWhiteName.toLowerCase() ||
                      u.toLowerCase() === gameBlackName.toLowerCase(),
                  ) || gameWhiteName;
                const isUserWhite = gameWhiteName.toLowerCase() === accountUsername.toLowerCase();
                opponent = isUserWhite ? game.players.black : game.players.white;
                accountName = isUserWhite ? gameWhiteName : gameBlackName;
                color = isUserWhite ? t("chess.white") : t("chess.black");
                const userWon = game.winner === (isUserWhite ? "white" : "black");
                result =
                  game.status === "white"
                    ? t("chess.white")
                    : game.status === "black"
                      ? t("chess.black")
                      : t("chess.draw");
                resultColor = isAcademiaMaya
                  ? userWon
                    ? "green"
                    : game.winner
                      ? "red"
                      : "gray"
                  : userWon
                    ? "teal"
                    : game.winner
                      ? "red"
                      : "gray";
              }

              const stats = gameStats.get(item.id);
              const pgn = analyzedPgns.get(item.id) || (item.game as any).pgn || null;

              return (
                <Table.Tr key={`${item.type}-${item.id}`}>
                  <Table.Td>
                    <Badge variant="light" color={item.type === "local" ? "blue" : item.type === "chesscom" ? "green" : "purple"}>
                      {item.type === "local" ? "Local" : item.type === "chesscom" ? "Chess.com" : "Lichess"}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Avatar size={24} radius="xl">
                        {(opponent.name || opponent.username || "?")[0]?.toUpperCase()}
                      </Avatar>
                      <Text>{opponent.name || opponent.username || "?"}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light">{color}</Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={resultColor}>{result}</Badge>
                  </Table.Td>
                  <Table.Td>
                    {stats ? (
                      <Text size="xs" fw={500}>
                        {stats.accuracy.toFixed(1)}%
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        -
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {stats ? (
                      <Text size="xs" fw={500}>
                        {stats.acpl.toFixed(1)}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        -
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {stats && stats.estimatedElo !== undefined ? (
                      <Text size="xs" fw={500}>
                        {stats.estimatedElo}
                      </Text>
                    ) : (
                      <Text size="xs" c="dimmed">
                        -
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{getMoveCount(item)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="yellow"
                      onClick={() => handleToggleFavorite(item)}
                      title="Remove from favorites"
                    >
                      <IconStarFilled size={16} />
                    </ActionIcon>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <AnalysisPreview pgn={pgn}>
                        <Button size="xs" variant="light" onClick={() => handleAnalyze(item)}>
                          Analyze
                        </Button>
                      </AnalysisPreview>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {totalPages > 1 && (
        <Group justify="center" mt="xs">
          <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
        </Group>
      )}
    </Stack>
  );
}

