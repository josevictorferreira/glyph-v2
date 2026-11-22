// RareUI-inspired component gallery barrel (rareui.com) — reimplemented on the Glyph design system.
// Kept separate from src/shared/ui/index.ts so `motion` stays out of the production entry chunk.

// AI kit
export { FluidOrb, type FluidOrbProps } from "./fluid-orb";
export { MatrixOrb, computeEnvelope, type MatrixOrbProps, type MatrixOrbState } from "./matrix-orb";
export { GridReveal, splitLargest, type GridRevealProps, type GridCell } from "./grid-reveal";
export { AiStatus, type AiStatusProps, type AiStatusState } from "./ai-status";
export { PromptBox, effortFromHoldMs, type PromptBoxProps, type PromptEffort } from "./prompt-box";
export {
  StreamingResponse,
  planNextBurst,
  burstDelay,
  type StreamingResponseProps,
  type Burst,
} from "./streaming-response";
export {
  ModelPicker,
  filterModels,
  moveHighlight,
  type ModelPickerProps,
  type PickerModel,
} from "./model-picker";
export {
  WebSearch,
  WebSearchAnswer,
  WebSearchCitation,
  type WebSearchProps,
  type WebSearchAnswerProps,
  type WebSearchCitationProps,
  type WebSource,
} from "./web-search";

// Display
export { Folder, type FolderProps } from "./folder";
export {
  CodeBlock,
  deriveCodeTheme,
  tokenizeCode,
  type CodeBlockProps,
  type CodeTheme,
  type CodeToken,
  type CodeTokenType,
} from "./code-block";
export {
  GravityLetters,
  stepParticles,
  type GravityLettersProps,
  type GlyphParticle,
  type GravityBounds,
} from "./gravity-letters";
export {
  GitHubActivity,
  type GitHubActivityProps,
  type Contribution,
  type RepoContribution,
} from "./github-activity";
export { StepPlayer, type StepPlayerProps, type StepPlayerStep } from "./step-player";
export {
  AnimatedCounter,
  formatCounterParts,
  type AnimatedCounterProps,
  type FormatCounterOptions,
  type CounterParts,
} from "./animated-counter";
export {
  VoiceNote,
  generateWaveform,
  clampSeek,
  type VoiceNoteProps,
} from "./voice-note";
export { Faq, type FaqProps, type FaqItem } from "./faq";

// Navigation
export {
  BounceSidebar,
  isHeading,
  selectableItems,
  type BounceSidebarProps,
  type BounceSidebarItem,
  type SelectableItem,
} from "./bounce-sidebar";
export {
  HookSidebar,
  activeIndexFromHash,
  type HookSidebarProps,
  type HookSidebarItem,
} from "./hook-sidebar";
export {
  ProximitySidebar,
  dashWidth,
  proximityStyle,
  type ProximitySidebarProps,
  type ProximitySection,
} from "./proximity-sidebar";
export {
  ScrollProgress,
  scrollMetrics,
  activeSection,
  type ScrollProgressProps,
  type ScrollProgressSection,
} from "./scroll-progress";
export {
  RailToc,
  activeFromScroll,
  type RailTocProps,
  type RailTocItem,
} from "./rail-toc";
export {
  GooeyNav,
  type GooeyNavProps,
  type GooeyNavItem,
  type GooeySize,
} from "./gooey-nav";

// Inputs
export {
  DurationPicker,
  clampDuration,
  type DurationPickerProps,
  type DurationValue,
} from "./duration-picker";
export {
  OtpInput,
  filterCode,
  type OtpInputProps,
  type OtpStatus,
  type OtpInputType,
  type OtpInputSize,
} from "./otp-input";
export {
  PasswordInput,
  passwordStrength,
  type PasswordInputProps,
  type PasswordStrengthScore,
} from "./password-input";
export {
  ThemeSelector,
  DEFAULT_THEMES,
  type ThemeSelectorProps,
  type ThemeOption,
} from "./theme-selector";
export { DeleteButton, type DeleteButtonProps } from "./delete-button";
export {
  TaskList,
  TaskItem,
  type TaskListProps,
  type TaskItemProps,
  type Task,
  type TaskListSize,
} from "./task-list";

// Feedback
export {
  RareToaster,
  rareToast,
  rareToastStore,
  toastReducer,
  type RareToasterProps,
  type RareToastOptions,
  type RareToastTone,
  type RareToastId,
  type RareToastPosition,
  type RareToastAction,
  type RareToastItem,
  type RareToastState,
  type RareToastStoreAction,
} from "./toast";
export {
  EmojiReaction,
  createRepeatScheduler,
  type EmojiReactionProps,
} from "./emoji-reaction";
export {
  NotificationBell,
  formatBadgeCount,
  type NotificationBellProps,
  type NotificationBellVariant,
  type NotificationBellColor,
} from "./notification-bell";
