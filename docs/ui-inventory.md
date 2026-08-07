# UI Inventory — baseline @ ui-monolith-baseline

index.html: 3544 lines

## data-act values (92)
```
add
apply-all
apply-sheet
check-all
check-history
choose-route
close-archive
close-palette
close-settings
close-sheet
convert
cr-add
cr-back
cr-continue
cr-create
cr-dest
cr-format
cr-move
cr-opt
cr-recipe
cr-remove
cr-save-recipe
cr-sort
cr-toggle
cycle-scope
download-helper
ed-apply-redactions
ed-canvas
ed-close-pair
ed-compress
ed-copy-right
ed-delete
ed-deselect
ed-extract
ed-grid
ed-insert
ed-move-left
ed-move-right
ed-numbers
ed-ocr
ed-open
ed-open-another
ed-revert
ed-rotate
ed-save
ed-save-b
ed-scope
ed-select-all
ed-step
ed-swap
ed-tool
ed-unmark
ed-zoom
folder
forget-folder
history-delete
history-deselect
history-filter
history-requeue
history-sort
open-sheet
open-url
palette-action
palette-conversion
recheck
rename-file
rename-history-file
requeue-one
reset-inspector
reveal-file
reveal-history
select-folder
select-helper
select-history
select-row
set-scope
settings-action
settings-copy
settings-helper
settings-menu
settings-pick
settings-search
settings-tab
settings-toggle
sheet-category
sheet-pick
toggle-advanced
toggle-folder-menu
toggle-names
toggle-picker
unlock-archive
update-field
```

## top-level globals (90)
```
const $
const APP_VERSION
const CREATOR_KINDS
const HIST_STATE
const ICON
const PANEL_WIDTH_STORAGE
const RANK
const SETTINGS_STORAGE
const SET_DATA
const SET_ROWS
const SET_TABS
const SORTS
const STROKE
const THEME_STORAGE
const U_ACTIVE
const U_FILTERS
const U_RANK
const U_STATE
const archivePromptSeen
const blockingHelper
const byId
const checkedOfKind
const commonFolder
const contextMenu
const crFmtSize
const creator
const destCount
const editor
const enterCreator
const enterEditor
const esc
const fmtSize
const fmtWhen
const helperData
const helperFound
const helperNames
const helperTools
const histCategory
const histState
const indeterminate
const inspectorHasContext
const inspectorVisible
const isBlocked
const isMac
const isRotated
const lineStyle
const missingHelpers
const pages
const panelResizeHandle
const routeCandidates
const routeStateClass
const routeStateLabel
const sameKind
const scopeLabel
const seenMarks
const selectedFile
const selectedTool
const setRow
const setScrim
const shell
const shortcutLabel
const systemTheme
const uRank
const waitingOn
const work
let actionStatus
let archivePromptId
let batchAnnounced
let containers
let countFresh
let creatorTimer
let editorEntering
let editorView
let folderMenuState
let freshRows
let histFilter
let inspectorOpen
let outputFolder
let page
let paletteOpen
let panelWidth
let prevStatus
let scope
let selbarShown
let selectedQueueIds
let setCopiedTimer
let settingsOpen
let themeHydrated
let themeName
let tools
```

## top-level functions (123)
```
async function api
async function applyAll
async function chooseRoute
async function commitHistoryRename
async function commitRename
async function convert
async function copyText
async function handleContextAction
async function historyAction
async function loadHistory
async function revealFile
async function revealRow
async function unlockArchive
function absorb
function applyHistorySelection
function applyQueueSelection
function applyRowCheck
function applyTheme
function chevron
function closeContextMenu
function closeFolderMenu
function closeSettings
function contextItem
function contextItems
function contextTargetFromRow
function convertRows
function creatorAddItems
function creatorBuildHtml
function creatorCellHtml
function creatorCreate
function creatorEmptyHtml
function creatorOptionHtml
function creatorOutputHtml
function creatorPickHtml
function creatorRecipesHtml
function creatorRowHtml
function creatorTakeFiles
function destinationHtml
function dropdownCloseMs
function editorDropHtml
function editorGridHtml
function editorGridPaneHtml
function editorRailHtml
function editorReaderHtml
function editorReaderPaneHtml
function fieldHtml
function fileThumb
function finishPanelResize
function folderIcon
function folderMenuHtml
function haptic
function historyRenameFieldHtml
function inspectorFacts
function installedHelpers
function metaLine
function movePanelResize
function noteTransitions
function openContextMenu
function openFolderMenu
function openPalette
function openSettings
function optionControl
function outputExt
function outputName
function outputStem
function pageCaption
function paletteHtml
function paletteItems
function panelBatch
function panelFile
function panelHistory
function pct
function readPanelWidth
function readSettings
function readTheme
function rememberEditorMotion
function renameFieldHtml
function render
function renderContextMenu
function renderConvert
function renderCreator
function renderCreatorPanel
function renderEditor
function renderEditorPair
function renderEditorPanel
function renderEditorView
function renderOverlays
function renderPanel
function renderSettings
function renderShortcutLabels
function revealTargetForRow
function routePopover
function setActionStatus
function setPage
function setPanelWidth
function setSetting
function setTools
function settingValue
function settingsHelperHtml
function settingsHelpersHtml
function settingsRowHtml
function settingsSectionHtml
function settlePanelWidth
function sheetFile
function sheetHtml
function showToast
function signature
function skeletonHtml
function startHistoryRename
function startPanelResize
function startRename
function statusClass
function statusText
function thumbHtml
function thumbKind
function tickIcon
function uMatches
function unifiedRow
function updateFieldFromControl
function visibleHistory
function visibleRows
function wireDrop
function writeSettings
```
