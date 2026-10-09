export { cn } from './lib/cn';
export { focusRing } from './lib/focus';
export { TONES, toneSoft, toneSolid, toneText, type Tone } from './lib/tones';
export { isBoolean, isStringArray, readStored, usePersistedState, writeStored } from './lib/persisted';
export {
    BREAKPOINT_PX,
    COARSE_POINTER_QUERY,
    MOBILE_QUERY,
    NARROW_QUERY,
    useCoarsePointer,
    useIsMobile,
    useIsNarrow,
    useMediaQuery,
} from './lib/breakpoints';
export {
    DND_INSTRUCTIONS,
    makeDndAnnouncements,
    type DndAnnouncementNames,
    type DndAnnouncements,
    type DndId,
} from './lib/dnd-announcements';

export * from './theme/theme';
export { ThemeProvider, useTheme, type ThemeProviderProps } from './theme/ThemeProvider';

export { Button, buttonVariants, type ButtonProps } from './components/button/Button';
export { Input, Textarea, fieldClasses, type InputProps, type TextareaProps } from './components/input/Input';
export { Field, type FieldProps } from './components/field/Field';
export * from './components/select/Select';
export { Checkbox, type CheckboxProps } from './components/checkbox/Checkbox';
export { Switch, type SwitchProps } from './components/switch/Switch';
export { Badge, StatusBadge, badgeVariants, type BadgeProps, type StatusBadgeProps } from './components/badge/Badge';
export * from './components/tooltip/Tooltip';
export * from './components/dialog/Dialog';
export * from './components/dropdown-menu/DropdownMenu';
export * from './components/tabs/Tabs';
export * from './components/command/Command';
export { Skeleton } from './components/skeleton/Skeleton';
export { EmptyState, type EmptyStateProps } from './components/empty-state/EmptyState';
export { DataTableShell, type DataTableShellProps } from './components/data-table/DataTableShell';
export { ThemeToggle } from './components/theme-toggle/ThemeToggle';

// Shell components (mockup v3, P1-UI-1)
export { IconTile, iconTileVariants, type IconTileProps } from './components/icon-tile/IconTile';
export { Delta, type DeltaProps } from './components/delta/Delta';
export { KpiCard, type KpiCardProps } from './components/kpi-card/KpiCard';
export { PageHeader, type PageHeaderProps } from './components/page-header/PageHeader';
export {
    Avatar,
    AvatarCell,
    avatarVariants,
    initialsOf,
    toneFor,
    type AvatarCellProps,
    type AvatarProps,
} from './components/avatar/Avatar';
export { ScoreBar, type ScoreBarProps } from './components/score-bar/ScoreBar';
export {
    SegmentedControl,
    type SegmentedControlProps,
    type SegmentedOption,
} from './components/segmented-control/SegmentedControl';
export { FactGrid, type Fact, type FactGridProps } from './components/fact-grid/FactGrid';
export { StageProgress, type Stage, type StageProgressProps } from './components/stage-progress/StageProgress';
export { CardList, LONG_PRESS_MS, type CardListItem, type CardListProps } from './components/card-list/CardList';
export {
    BottomActionBar,
    BottomActionBarItem,
    type BottomActionBarItemProps,
    type BottomActionBarProps,
} from './components/bottom-action-bar/BottomActionBar';
export {
    DataTableChrome,
    RowActionsMenu,
    pageWindow,
    phoneRoles,
    tableClasses,
    type DataTableChromeProps,
    type PhoneRole,
    type TableColumn,
    type TableData,
    type TableRowActions,
    type TablePagination,
    type TableSearch,
    type TableTab,
    type TableToolbar,
} from './components/data-table-chrome/DataTableChrome';
export { BulkBar, BulkBarAction, type BulkBarProps } from './components/bulk-bar/BulkBar';
export {
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerSection,
    DrawerTrigger,
    type DrawerContentProps,
} from './components/drawer/Drawer';
export {
    ActivityTimeline,
    type ActivityItem,
    type ActivityTimelineProps,
} from './components/activity-timeline/ActivityTimeline';
export { ActionList, type ActionListItem, type ActionListProps } from './components/action-list/ActionList';
export {
    CardChip,
    DealCard,
    KanbanBoard,
    KanbanLane,
    type DealCardProps,
    type KanbanLaneProps,
} from './components/kanban/Kanban';
export { WelcomePanel, type WelcomeFact, type WelcomePanelProps } from './components/welcome-panel/WelcomePanel';
export {
    TOAST_DURATION_MS,
    TOAST_LIMIT,
    ToastStore,
    toast,
    toasts,
    useToasts,
    type ToastInput,
    type ToastRecord,
} from './components/toast/toast-store';
// The renderer is a subpath of its own (`@bylinecrm/ui/toaster`) so an app can load it lazily;
// re-exporting it here would put Radix Toast in every page's first load.
