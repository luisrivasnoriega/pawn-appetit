import {
  ActionIcon,
  Box,
  Divider,
  Group,
  Overlay,
  Paper,
  rgba,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useColorScheme, useHotkeys, useToggle } from "@mantine/hooks";
import {
  IconArrowRight,
  IconArrowsSplit,
  IconArticle,
  IconArticleOff,
  IconChevronDown,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconListTree,
  IconPoint,
  IconPointFilled,
} from "@tabler/icons-react";
import { INITIAL_FEN } from "chessops/fen";
import equal from "fast-deep-equal";
import { useAtom, useAtomValue } from "jotai";
import React, { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Comment } from "@/components/Comment";
import { TreeStateContext } from "@/components/TreeStateContext";
import { currentInvisibleAtom } from "@/state/atoms";
import { keyMapAtom } from "@/state/keybindings";
import type { TreeNode } from "@/utils/treeReducer";
import CompleteMoveCell from "./CompleteMoveCell";
import * as styles from "./GameNotation.css";
import * as moveStyles from "./MoveCell.css";
import OpeningName from "./OpeningName";

type VariationState = "mainline" | "variations" | "repertoire" | "report";

const variationRefs = {
  mainline: React.createRef<HTMLSpanElement>(),
  variations: React.createRef<HTMLSpanElement>(),
  repertoire: React.createRef<HTMLSpanElement>(),
  report: React.createRef<HTMLSpanElement>(),
};

function isOnNextDivergenceFromMainline(node: TreeNode, remainingPath: number[]): boolean {
  if (remainingPath.length === 0) return false;
  if (!node.children) return false;
  if (node.children.length > 1) {
    if (remainingPath[0] > node.children.length) return false;
    return remainingPath[0] !== 0;
  }
  const nextNode = node.children[remainingPath[0]];
  if (!nextNode) return false;
  return isOnNextDivergenceFromMainline(nextNode, remainingPath.slice(1));
}

function hasMultipleChildrenInChain(node: TreeNode): boolean {
  if (!node.children) return false;
  if (node.children.length > 1) return true;
  if (node.children.length === 1) {
    return hasMultipleChildrenInChain(node.children[0]);
  }
  return false;
}

function hasMultipleChildrenUntilPosition(node: TreeNode, remainingPath: number[]): boolean {
  if (remainingPath.length === 0) return false;
  if (!node.children) return false;
  if (node.children.length > 1) return true;
  const nextNode = node.children[remainingPath[0]];
  if (!nextNode) return false;
  return hasMultipleChildrenUntilPosition(nextNode, remainingPath.slice(1));
}

function GameNotation({
  topBar,
  initialVariationState = "mainline",
}: {
  topBar?: boolean;
  initialVariationState?: VariationState;
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("GameNotation must be used within a TreeStateProvider");
  }

  const root = useStore(store, (s) => s.root);
  const currentFen = useStore(store, (s) => s.currentNode().fen);
  const headers = useStore(store, (s) => s.headers);

  const viewport = useRef<HTMLDivElement>(null);

  const [invisibleValue, setInvisible] = useAtom(currentInvisibleAtom);
  const [variationState, toggleVariationState] = useToggle([
    initialVariationState,
    ...["mainline", "variations", "repertoire", "report"].filter((v) => v !== initialVariationState),
  ]) as [VariationState, () => void];
  const [showComments, toggleComments] = useToggle([true, false]);

  const invisible = topBar && invisibleValue;
  const { colorScheme } = useMantineColorScheme();
  const osColorScheme = useColorScheme();
  const keyMap = useAtomValue(keyMapAtom);
  const { t } = useTranslation();

  useHotkeys([[keyMap.TOGGLE_BLUR.keys, () => setInvisible((prev: boolean) => !prev)]]);

  useEffect(() => {
    if (viewport.current) {
      if (currentFen === INITIAL_FEN) {
        viewport.current.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        const currentRef = variationRefs[variationState];
        if (currentRef?.current) {
          viewport.current.scrollTo({
            top: currentRef.current.offsetTop - 65,
            behavior: "smooth",
          });
        }
      }
    }
  }, [currentFen, variationState]);

  return (
    <Paper withBorder p="md" flex={1} style={{ position: "relative", overflow: "hidden" }}>
      <Stack h="100%" gap={0}>
        {topBar && (
          <NotationHeader
            showComments={showComments}
            toggleComments={toggleComments}
            variationState={variationState}
            toggleVariationState={toggleVariationState}
          />
        )}
        <ScrollArea flex={1} offsetScrollbars viewportRef={viewport}>
          <Stack pt="md">
            <Box>
              {invisible && (
                <Overlay
                  backgroundOpacity={0.6}
                  color={
                    colorScheme === "dark" || (osColorScheme === "dark" && colorScheme === "auto")
                      ? "#1a1b1e"
                      : undefined
                  }
                  blur={8}
                  zIndex={2}
                />
              )}
              {showComments && root.comment && <Comment comment={root.comment} />}
              <Box
                style={{
                  display: variationState === "mainline" ? "block" : "none",
                }}
              >
                <RenderMainline
                  tree={root}
                  depth={0}
                  path={[]}
                  start={headers.start}
                  first={true}
                  showComments={showComments}
                  // @ts-expect-error
                  targetRef={variationRefs.mainline}
                  toggleVariationState={toggleVariationState}
                />
              </Box>
              <Box
                style={{
                  display: variationState === "variations" ? "block" : "none",
                }}
              >
                <RenderVariations
                  tree={root}
                  depth={0}
                  path={[]}
                  start={headers.start}
                  first={true}
                  showComments={showComments}
                  renderMoves={false}
                  nextLevelExpanded={true}
                  // @ts-expect-error
                  targetRef={variationRefs.variations}
                  variationState={variationState}
                  childInPath={false}
                />
              </Box>
              <Box
                style={{
                  display: variationState === "repertoire" ? "block" : "none",
                }}
              >
                <RenderRepertoire
                  tree={root}
                  depth={0}
                  path={[]}
                  start={headers.start}
                  showComments={showComments}
                  nextLevelExpanded={true}
                  // @ts-expect-error
                  targetRef={variationRefs.repertoire}
                  variationState={variationState}
                />
              </Box>
              <Box
                style={{
                  display: variationState === "report" ? "block" : "none",
                }}
              >
                <RenderReport
                  tree={root}
                  depth={0}
                  path={[]}
                  start={headers.start}
                  showComments={showComments}
                  // @ts-expect-error
                  targetRef={variationRefs.report}
                  variationState={variationState}
                />
              </Box>
            </Box>
            {headers.result && headers.result !== "*" && (
              <Text ta="center">
                {headers.result}
                <br />
                <Text span fs="italic">
                  {headers.result === "1/2-1/2"
                    ? t("chess.outcome.draw")
                    : headers.result === "1-0"
                      ? t("chess.outcome.whiteWins")
                      : t("chess.outcome.blackWins")}
                </Text>
              </Text>
            )}
          </Stack>
        </ScrollArea>
      </Stack>
    </Paper>
  );
}

function NotationHeader({
  showComments,
  toggleComments,
  variationState,
  toggleVariationState,
}: {
  showComments: boolean;
  toggleComments: () => void;
  variationState: VariationState;
  toggleVariationState: () => void;
}) {
  const [invisible, setInvisible] = useAtom(currentInvisibleAtom);
  const { t } = useTranslation();

  return (
    <Stack>
      <Group justify="space-between">
        <OpeningName />
        <Group gap="sm">
          <Tooltip label={invisible ? t("features.gameNotation.showMoves") : t("features.gameNotation.hideMoves")}>
            <ActionIcon onClick={() => setInvisible((prev: boolean) => !prev)}>
              {invisible ? <IconEyeOff size="1rem" /> : <IconEye size="1rem" />}
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={showComments ? t("features.gameNotation.hideComments") : t("features.gameNotation.showComments")}
          >
            <ActionIcon onClick={toggleComments}>
              {showComments ? <IconArticle size="1rem" /> : <IconArticleOff size="1rem" />}
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={
              variationState === "variations"
                ? t("features.gameNotation.showVariations")
                : variationState === "repertoire"
                  ? t("features.gameNotation.repertoireView")
                  : variationState === "report"
                    ? t("features.gameNotation.reportView")
                    : t("features.gameNotation.mainLine")
            }
          >
            <ActionIcon onClick={toggleVariationState}>
              {variationState === "variations" ? (
                <IconArrowsSplit size="1rem" />
              ) : variationState === "repertoire" ? (
                <IconListTree size="1rem" />
              ) : variationState === "report" ? (
                <IconFileText size="1rem" />
              ) : (
                <IconArrowRight size="1rem" />
              )}
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <Divider />
    </Stack>
  );
}

function RenderMainline({
  tree,
  depth,
  path,
  start,
  first,
  showComments,
  targetRef,
  toggleVariationState,
}: {
  tree: TreeNode;
  depth: number;
  start?: number[];
  first?: boolean;
  showComments: boolean;
  targetRef: React.RefObject<HTMLSpanElement>;
  path: number[];
  toggleVariationState: () => void;
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("RenderMainline must be used within a TreeStateProvider");
  }
  const currentPosition = useStore(store, (s) => s.position);
  const theme = useMantineTheme();
  const { t } = useTranslation();

  const variations = tree.children;
  if (!variations?.length) return null;

  const newPath = [...path, 0];
  const isAtDivergence =
    currentPosition.length > path.length &&
    currentPosition.slice(0, path.length).every((v, i) => path[i] === v) &&
    currentPosition[path.length] > 0;

  return (
    <>
      {isAtDivergence && (
        <Box
          component="span"
          style={{
            display: "inline-block",
            fontSize: "80%",
          }}
        >
          <Tooltip label={t("features.gameNotation.showVariationsTooltip")}>
            <Box
              component="button"
              className={moveStyles.cell}
              onClick={toggleVariationState}
              style={{
                backgroundColor: rgba(theme.colors.gray[6], 0.2),
              }}
            >
              <IconArrowsSplit size="1rem" style={{ verticalAlign: "text-bottom" }} />
            </Box>
          </Tooltip>
        </Box>
      )}
      <CompleteMoveCell
        annotations={variations[0].annotations}
        comment={variations[0].comment}
        halfMoves={variations[0].halfMoves}
        move={variations[0].san}
        fen={variations[0].fen}
        movePath={newPath}
        showComments={showComments}
        isStart={equal(newPath, start)}
        first={first}
        targetRef={targetRef}
      />
      <RenderMainline
        tree={variations[0]}
        depth={depth}
        start={start}
        showComments={showComments}
        targetRef={targetRef}
        path={newPath}
        toggleVariationState={toggleVariationState}
      />
    </>
  );
}

function RenderVariations({
  tree,
  depth,
  path,
  start,
  first,
  showComments,
  renderMoves,
  nextLevelExpanded,
  childInPath,
  targetRef,
  variationState,
}: {
  tree: TreeNode;
  depth: number;
  path: number[];
  start?: number[];
  first?: boolean;
  showComments: boolean;
  renderMoves: boolean;
  nextLevelExpanded: boolean;
  childInPath: boolean;
  targetRef: React.RefObject<HTMLSpanElement>;
  variationState: VariationState;
}) {
  if (!renderMoves) {
    const variationCells = [];
    let currentNode = tree;
    let currentPath = [...path];
    let parentNode = currentNode;

    if (!currentNode.children?.length) return null;

    variationCells.push(
      <VariationCell
        key={currentNode.fen}
        variation={currentNode}
        path={currentPath}
        variationState={variationState}
        targetRef={targetRef}
        start={start}
        showComments={showComments}
        depth={depth + 1}
        startsMainline={true}
        childInPath={childInPath}
        nextLevelExpanded={nextLevelExpanded}
      />,
    );

    let pathIncludesChild = childInPath;
    while (currentNode.children.length > 0) {
      parentNode = currentNode;
      currentNode = currentNode.children[0];
      if (!pathIncludesChild) {
        currentPath = [...currentPath, 0];
      } else {
        pathIncludesChild = false;
      }

      if (parentNode.children.length > 1 && currentNode.children.length > 0) {
        variationCells.push(
          <VariationCell
            key={currentNode.fen}
            variation={currentNode}
            path={currentPath}
            variationState={variationState}
            targetRef={targetRef}
            start={start}
            showComments={showComments}
            depth={depth + 1}
            startsMainline={false}
            childInPath={false}
            nextLevelExpanded={nextLevelExpanded}
          />,
        );
      }
    }

    return <>{variationCells}</>;
  }

  const variations = tree.children;
  if (!variations?.length) return null;

  const newMainlinePath = childInPath ? [...path] : [...path, 0];

  if (variations.length === 1) {
    return (
      <>
        <CompleteMoveCell
          targetRef={targetRef}
          annotations={variations[0].annotations}
          comment={variations[0].comment}
          halfMoves={variations[0].halfMoves}
          move={variations[0].san}
          fen={variations[0].fen}
          movePath={newMainlinePath}
          showComments={showComments}
          isStart={equal(newMainlinePath, start)}
          first={first}
        />
        <RenderVariations
          tree={variations[0]}
          depth={depth}
          start={start}
          showComments={showComments}
          targetRef={targetRef}
          path={newMainlinePath}
          variationState={variationState}
          renderMoves={true}
          childInPath={false}
          nextLevelExpanded={nextLevelExpanded}
        />
      </>
    );
  }

  return (
    <>
      <CompleteMoveCell
        targetRef={targetRef}
        annotations={variations[0].annotations}
        comment={variations[0].comment}
        halfMoves={variations[0].halfMoves}
        move={variations[0].san}
        fen={variations[0].fen}
        movePath={newMainlinePath}
        showComments={showComments}
        isStart={equal(newMainlinePath, start)}
        first={first}
      />
      {variations.slice(1).map((variation, index) => (
        <RenderVariations
          key={variation.fen}
          tree={{ ...variation, children: [variation] }}
          depth={depth}
          start={start}
          showComments={showComments}
          targetRef={targetRef}
          path={[...newMainlinePath.slice(0, -1), index + 1]}
          variationState={variationState}
          renderMoves={false}
          childInPath={true}
          nextLevelExpanded={nextLevelExpanded}
        />
      ))}
    </>
  );
}

function VariationCell({
  variation,
  path,
  depth,
  start,
  showComments,
  startsMainline,
  childInPath,
  nextLevelExpanded,
  targetRef,
  variationState,
}: {
  variation: TreeNode;
  path: number[];
  variationState: VariationState;
  targetRef: React.RefObject<HTMLSpanElement>;
  start?: number[];
  showComments: boolean;
  depth: number;
  startsMainline: boolean;
  childInPath: boolean;
  nextLevelExpanded: boolean;
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("VariationCell must be used within a TreeStateProvider");
  }
  const positionPath = useStore(store, (s) => s.position);

  const currentPath = childInPath ? [...path.slice(0, -1)] : [...path];
  const childIndex = childInPath ? path[path.length - 1] : 0;
  const remainingPositionPath = positionPath.slice(currentPath.length);

  const isOnPath = currentPath.every((value, i) => positionPath[i] === value);
  const isPositionDeeper = positionPath.length > currentPath.length;
  const isDiverging =
    remainingPositionPath.length > 0 &&
    ((remainingPositionPath[0] !== 0 && childIndex === 0) ||
      (remainingPositionPath[0] === childIndex &&
        isOnNextDivergenceFromMainline(variation, [0, ...remainingPositionPath.slice(1)])));
  const isInCurrentPath = isOnPath && isPositionDeeper && isDiverging;

  const [expanded, setExpanded] = useState(() => isInCurrentPath);
  const [chevronClicked, setChevronClicked] = useState(false);

  useEffect(() => {
    if (!expanded && variationState === "variations" && isInCurrentPath) {
      setExpanded(true);
    }
  }, [variationState, expanded, isInCurrentPath]);

  if (depth > 1 && !nextLevelExpanded) {
    return null;
  }

  return (
    <Box className={depth === 1 ? undefined : styles.variationBorder}>
      {hasMultipleChildrenInChain(variation) ? (
        expanded ? (
          isInCurrentPath ? (
            <span style={{ width: "0.6rem", display: "inline-block" }} />
          ) : (
            <IconChevronDown
              size="0.6rem"
              style={{
                opacity: chevronClicked ? 1 : 0,
                transition: "opacity 0.4s",
                cursor: "pointer",
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(event) => {
                setChevronClicked(false);
                event.currentTarget.style.opacity = "0";
              }}
              onClick={() => setExpanded(false)}
            />
          )
        ) : (
          <IconChevronRight
            size="0.6rem"
            style={{
              cursor: "pointer",
            }}
            onClick={() => {
              setChevronClicked(true);
              setExpanded(true);
            }}
          />
        )
      ) : (
        <span style={{ width: "0.6rem", display: "inline-block" }} />
      )}
      {startsMainline ? <IconPointFilled size="0.6rem" /> : <IconPoint size="0.6rem" />}
      <RenderVariations
        tree={variation}
        depth={depth}
        path={path}
        start={start}
        showComments={showComments}
        first={true}
        renderMoves={true}
        nextLevelExpanded={expanded}
        targetRef={targetRef}
        variationState={variationState}
        childInPath={childInPath}
      />
    </Box>
  );
}

function RenderRepertoire({
  tree,
  depth,
  path,
  start,
  first,
  showComments,
  nextLevelExpanded,
  targetRef,
  variationState,
}: {
  tree: TreeNode;
  depth: number;
  start?: number[];
  path: number[];
  first?: boolean;
  showComments: boolean;
  nextLevelExpanded?: boolean;
  targetRef: React.RefObject<HTMLSpanElement>;
  variationState: VariationState;
}) {
  const variations = tree.children;
  if (!variations?.length) return null;

  if (variations.length === 1 && depth > 0) {
    const newPath = [...path, 0];
    return (
      <>
        <CompleteMoveCell
          targetRef={targetRef}
          annotations={variations[0].annotations}
          comment={variations[0].comment}
          halfMoves={variations[0].halfMoves}
          move={variations[0].san}
          fen={variations[0].fen}
          movePath={newPath}
          showComments={showComments}
          isStart={equal(newPath, start)}
          first={first}
        />
        <RenderRepertoire
          targetRef={targetRef}
          tree={variations[0]}
          depth={depth}
          start={start}
          showComments={showComments}
          path={newPath}
          variationState={variationState}
          nextLevelExpanded={nextLevelExpanded}
        />
      </>
    );
  }

  return (
    <>
      {variations.map((variation, index) => (
        <RepertoireCell
          key={variation.fen}
          variation={variation}
          path={[...path, index]}
          targetRef={targetRef}
          start={start}
          showComments={showComments}
          depth={depth + 1}
          variationState={variationState}
          nextLevelExpanded={nextLevelExpanded}
        />
      ))}
    </>
  );
}

function RepertoireCell({
  variation,
  path,
  depth,
  start,
  showComments,
  nextLevelExpanded,
  targetRef,
  variationState,
}: {
  variation: TreeNode;
  path: number[];
  variationState: VariationState;
  targetRef: React.RefObject<HTMLSpanElement>;
  start?: number[];
  showComments: boolean;
  depth: number;
  nextLevelExpanded?: boolean;
}) {
  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("RepertoireCell must be used within a TreeStateProvider");
  }
  const position = useStore(store, (s) => s.position);

  const isOnPath = path.every((value, i) => position[i] === value);
  const isPositionDeeper = position.length > path.length;
  const remainingPath = position.slice(path.length);
  const isInCurrentPath = isPositionDeeper && isOnPath && hasMultipleChildrenUntilPosition(variation, remainingPath);

  const [expanded, setExpanded] = useState(() => isInCurrentPath);
  const [chevronClicked, setChevronClicked] = useState(false);

  useEffect(() => {
    if (!expanded && variationState === "repertoire" && isInCurrentPath) {
      setExpanded(true);
    }
  }, [variationState, expanded, isInCurrentPath]);

  if (depth > 1 && !nextLevelExpanded) {
    return null;
  }

  return (
    <Box className={depth === 1 ? undefined : styles.variationBorder}>
      {hasMultipleChildrenInChain(variation) ? (
        expanded ? (
          isInCurrentPath ? (
            <span style={{ width: "0.6rem", display: "inline-block" }} />
          ) : (
            <IconChevronDown
              size="0.6rem"
              style={{
                opacity: chevronClicked ? 1 : 0,
                transition: "opacity 0.4s",
                cursor: "pointer",
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.opacity = "1";
              }}
              onMouseLeave={(event) => {
                setChevronClicked(false);
                event.currentTarget.style.opacity = "0";
              }}
              onClick={() => setExpanded(false)}
            />
          )
        ) : (
          <IconChevronRight
            size="0.6rem"
            style={{
              cursor: "pointer",
            }}
            onClick={() => {
              setChevronClicked(true);
              setExpanded(true);
            }}
          />
        )
      ) : (
        <span style={{ width: "0.6rem", display: "inline-block" }} />
      )}
      <IconPointFilled size="0.6rem" />
      <CompleteMoveCell
        annotations={variation.annotations}
        comment={variation.comment}
        halfMoves={variation.halfMoves}
        move={variation.san}
        fen={variation.fen}
        movePath={path}
        showComments={showComments}
        isStart={equal(path, start)}
        first={true}
        targetRef={targetRef}
      />
      <RenderRepertoire
        tree={variation}
        depth={depth}
        path={path}
        start={start}
        showComments={showComments}
        nextLevelExpanded={expanded}
        targetRef={targetRef}
        variationState={variationState}
      />
    </Box>
  );
}

function RenderReport({
  tree,
  depth,
  path,
  start,
  showComments,
  targetRef,
  variationState,
}: {
  tree: TreeNode;
  depth: number;
  path: number[];
  start?: number[];
  showComments: boolean;
  targetRef: React.RefObject<HTMLSpanElement>;
  variationState: VariationState;
}) {
  const variations = tree.children;
  if (!variations?.length) return null;

  return (
    <Box component="div" style={{ display: "flex", flexDirection: "column" }}>
      {variations.map((child, index) => (
        <ReportLine
          key={child.fen}
          tree={child}
          path={[...path, index]}
          depth={depth}
          start={start}
          showComments={showComments}
          targetRef={targetRef}
          variationState={variationState}
          variantDepth={index > 0 ? 1 : 0}
          isVariation={index > 0}
          parentIndentSize={0}
        />
      ))}
    </Box>
  );
}

function ReportLine({
  tree,
  path,
  depth,
  start,
  showComments,
  targetRef,
  variationState,
  variantDepth,
  isVariation = false,
  parentIndentSize = 0,
}: {
  tree: TreeNode;
  path: number[];
  depth: number;
  start?: number[];
  showComments: boolean;
  targetRef: React.RefObject<HTMLSpanElement>;
  variationState: VariationState;
  variantDepth: number;
  isVariation?: boolean;
  parentIndentSize?: number;
}) {
  // Calculate absolute indent size based on variant depth
  // This ensures all moves in the same variant have the same indent
  const absoluteIndentSize = variantDepth * 1.5;
  // Only apply additional indent if this is the start of a new variation
  const currentIndentSize = isVariation ? absoluteIndentSize - parentIndentSize : 0;

  // If this node has no move, just recurse into its children
  if (!tree.san) {
    const children = tree.children;
    if (!children?.length) return null;

    return (
      <>
        {children.map((child, index) => (
          <ReportLine
            key={child.fen}
            tree={child}
            path={[...path, index]}
            depth={depth}
            start={start}
            showComments={showComments}
            targetRef={targetRef}
            variationState={variationState}
            variantDepth={variantDepth}
            isVariation={false}
            parentIndentSize={absoluteIndentSize}
          />
        ))}
      </>
    );
  }

  const moveNumber = Math.ceil(tree.halfMoves / 2);
  const isWhite = tree.halfMoves % 2 === 1;
  const children = tree.children || [];
  const hasMultipleVariations = children.length > 1;
  const mainLineChild = children[0];
  
  // Check if we should show white and black moves on the same line
  // Incluso si hay múltiples respuestas de negras, mostramos la principal
  // en la misma línea que la jugada de blancas.
  const shouldShowBlackOnSameLine =
    isWhite && mainLineChild && Math.ceil(mainLineChild.halfMoves / 2) === moveNumber;

  // Only show move number for white moves (or start of variation)
  const showMoveNumber = isWhite || (isVariation && !isWhite);
  const label = isWhite ? `${moveNumber}.` : (isVariation ? `${moveNumber}...` : "");

  return (
    <Box
      component="div"
      style={{
        marginLeft: currentIndentSize > 0 ? `${currentIndentSize}rem` : "0",
        display: "block",
        marginBottom: "0.1rem",
      }}
    >
      <Box
        component="div"
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "0.5rem",
          flexWrap: "nowrap",
        }}
      >
        {showMoveNumber && (
          <Text
            component="span"
            style={{
              minWidth: "2.5rem",
              display: "inline-block",
              fontSize: "0.9rem",
            }}
          >
            {label}
          </Text>
        )}
        <Box component="span" style={{ display: "inline-block" }}>
          <CompleteMoveCell
            targetRef={targetRef}
            annotations={tree.annotations}
            comment={tree.comment}
            halfMoves={0}
            move={tree.san}
            fen={tree.fen}
            movePath={path}
            showComments={showComments}
            isStart={equal(path, start)}
            first={false}
          />
        </Box>
        {/* Render black's response on the same line if it exists and is the main line continuation */}
        {shouldShowBlackOnSameLine && mainLineChild && (
          <Box component="span" style={{ display: "inline-block", marginLeft: "0.25rem" }}>
            <CompleteMoveCell
              targetRef={targetRef}
              annotations={mainLineChild.annotations}
              comment={mainLineChild.comment}
              halfMoves={0}
              move={mainLineChild.san}
              fen={mainLineChild.fen}
              movePath={[...path, 0]}
              showComments={showComments}
              isStart={equal([...path, 0], start)}
              first={false}
            />
          </Box>
        )}
      </Box>

      {showComments && tree.comment && (
        <Box
          component="div"
          style={{
            paddingLeft: "2.5rem",
            fontSize: "0.875rem",
            marginTop: "0.25rem",
          }}
        >
          <Comment comment={tree.comment} />
        </Box>
      )}

      {/* Render continuation and variations */}
      {children.length > 0 && (
        <>
          {shouldShowBlackOnSameLine && mainLineChild ? (
            <>
              {/* 1) Otras respuestas de negras al mismo tiempo (variantes de 5...X) */}
              {children.map((child, index) => {
                if (index === 0) return null; // ya se mostró en la misma línea

                const isChildVariation = hasMultipleVariations && index > 0;
                const childVariantDepth = isChildVariation ? variantDepth + 1 : variantDepth;

                // Estas son siempre variantes: queremos que se muestren como "N..."
                const isVariationForDisplay = true;

                return (
                  <ReportLine
                    key={child.fen}
                    tree={child}
                    path={[...path, index]}
                    depth={depth}
                    start={start}
                    showComments={showComments}
                    targetRef={targetRef}
                    variationState={variationState}
                    variantDepth={childVariantDepth}
                    isVariation={isVariationForDisplay}
                    parentIndentSize={absoluteIndentSize}
                  />
                );
              })}

              {/* 2) Continuación de la línea principal después de la respuesta principal de negras */}
              {mainLineChild.children?.map((grandChild, grandIndex) => {
                const grandChildren = mainLineChild.children || [];
                const grandHasMultipleVariations = grandChildren.length > 1;
                const isGrandVariation = grandHasMultipleVariations && grandIndex > 0;
                const grandVariantDepth = isGrandVariation ? variantDepth + 1 : variantDepth;

                return (
                  <ReportLine
                    key={grandChild.fen}
                    tree={grandChild}
                    path={[...path, 0, grandIndex]}
                    depth={depth}
                    start={start}
                    showComments={showComments}
                    targetRef={targetRef}
                    variationState={variationState}
                    variantDepth={grandVariantDepth}
                    isVariation={isGrandVariation}
                    parentIndentSize={absoluteIndentSize}
                  />
                );
              })}
            </>
          ) : (
            <>
              {children.map((child, index) => {
                // Only increase variantDepth when starting a NEW variation (index > 0)
                // Continuations (index === 0) keep the same variantDepth
                const isChildVariation = hasMultipleVariations && index > 0;
                const childVariantDepth = isChildVariation ? variantDepth + 1 : variantDepth;
                const childIsWhite = child.halfMoves % 2 === 1;

                // Determine if this child is a variation (for display/label purposes)
                // Queremos que las líneas que empiezan con una jugada de negras en una
                // posición con múltiples continuaciones se muestren como "N...".
                // Por ello, en presencia de varias variantes:
                // - cualquier hijo de negras se trata como variación (para forzar "N...")
                // - y, como antes, cualquier hijo con index > 0 también es variación.
                const isVariationForDisplay =
                  hasMultipleVariations && (!childIsWhite || index > 0);

                return (
                  <ReportLine
                    key={child.fen}
                    tree={child}
                    path={[...path, index]}
                    depth={depth}
                    start={start}
                    showComments={showComments}
                    targetRef={targetRef}
                    variationState={variationState}
                    variantDepth={childVariantDepth}
                    isVariation={isVariationForDisplay}
                    parentIndentSize={absoluteIndentSize}
                  />
                );
              })}
            </>
          )}
        </>
      )}
    </Box>
  );
}

export default GameNotation;
