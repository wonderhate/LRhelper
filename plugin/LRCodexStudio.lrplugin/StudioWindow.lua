local LrApplication = import 'LrApplication'
local LrBinding = import 'LrBinding'
local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrFunctionContext = import 'LrFunctionContext'
local LrPrefs = import 'LrPrefs'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'
local Client = require 'StudioClient'

local Window = {}

function Window.show()
    if _G.LRCodexStudio_WindowOpen then
        if _G.LRCodexStudio_ToFront then _G.LRCodexStudio_ToFront(); return end
        LrDialogs.message('LR Codex Studio', '工作台已经打开，请切换到现有窗口。', 'info')
        return
    end
    _G.LRCodexStudio_WindowOpen = true
    LrTasks.startAsyncTask(function()
        local ok, failure = LrTasks.pcall(function()
            LrFunctionContext.callWithContext('Studio window', function(context)
                local p = LrBinding.makePropertyTable(context)
                local prefs = LrPrefs.prefsForPlugin()
                local f = LrView.osFactory()
                local bind = LrView.bind
                local closed, currentJob, applyingJob = false, nil, false
                local refreshWorkspace, loadHistory, openBatch, showBatchPhoto
                local stylesById, conversationsById = {}, {}
                local currentBatch, batchRows, knownBatches = nil, {}, {}

                p.mode = prefs.mode or 'describe'
                p.prompt = prefs.prompt or ''
                p.reference = prefs.reference or ''
                p.strength = prefs.strength or 65
                p.localMasks = false
                p.maskHint = '适用于单张照片'
                p.photo = '请在 Lightroom 中选中一张照片。'
                p.status = '读取照片后，选择调色方式并生成方案。'
                p.analysis = '生成方案后，这里显示目标分析、参考关系和适配说明。'
                p.diff = '尚无参数方案。生成方案不会修改照片。'
                p.beforePath, p.afterPath = '', ''
                p.hasBefore, p.hasAfter = false, false
                p.beforeEmpty, p.afterEmpty = true, true
                p.previewGuide = '这里显示 Lightroom 渲染的虚拟副本。'
                p.referencePreviewPath = p.mode == 'reference' and p.reference ~= '' and LrFileUtils.exists(p.reference) and p.reference or ''
                p.afterTitle = '副本预览（待读取照片）'
                p.detailTab = 'diff'
                p.busy, p.idle = false, true
                p.canGenerate, p.canPreview, p.canRestore, p.canCancel = false, false, false, false
                p.loading, p.listBusy = false, false
                p.feedback, p.historyText = '', '生成并预览第一轮后，在这里继续调整。'
                local historyPages, historyPage = { p.historyText }, 1
                p.historyPosition = '1 / 1'
                p.conversationItems = { { title = '暂无会话', value = '' } }
                p.revisionItems = { { title = '暂无轮次', value = '' } }
                p.styleItems = { { title = '尚无已保存风格', value = '' } }
                p.conversationChoice, p.revisionChoice, p.selectedStyle = '', '', ''
                p.styleName, p.libraryReferencePath = '', ''
                p.librarySummary = '预览满意后保存风格。风格包含调色意图和参考图副本，应用时按新照片适配。'
                local xmpGuide = 'XMP 导出固定参数。应用预设时沿用目标照片的曝光和白平衡。'
                p.xmpNote = xmpGuide
                p.batchItems = { { title = '暂无批次', value = '' } }
                p.batchPhotoItems = { { title = '暂无批次照片', value = '' } }
                p.batchChoice, p.batchPhotoChoice = '', ''
                p.batchMessage = '在 Lightroom 中选择 2–8 张照片，然后生成批次方案。'
                p.batchDetail = '生成后可逐张查看方案。预览会为每张照片创建独立副本。'

                local function hasChanges(job)
                    return job and ((job.diff and job.diff ~= '') or job.hasMaskChanges == true)
                end

                local function buttons()
                    p.idle = not p.busy and not p.loading
                    p.canEditReference = p.idle and p.mode == 'reference'
                    p.maskHint = currentJob and currentJob.hasMaskChanges == true and not p.localMasks and '继续调整会保留已有蒙版' or '适用于单张照片'
                    p.canGenerate = p.idle and p.photoId ~= nil
                    p.canPreview = p.idle and currentJob ~= nil and currentJob.status == 'planned' and hasChanges(currentJob) == true
                    p.hasBefore, p.hasAfter = p.beforePath ~= '', p.afterPath ~= ''
                    p.beforeEmpty, p.afterEmpty = not p.hasBefore, not p.hasAfter
                    p.previewGuide = p.canPreview and '点击「预览副本」查看调色效果。' or '这里显示 Lightroom 渲染的虚拟副本。'
                    p.canRestore = p.idle and currentJob ~= nil and currentJob.canRestore == true
                    p.canRefine = p.idle and currentJob ~= nil and currentJob.canRefine == true
                    p.canSubmitRefine = p.canRefine and p.feedback:find('%S') ~= nil
                    p.canSaveStyle = p.canRefine
                    local selectedStyle = stylesById[p.selectedStyle]
                    p.canApplyStyle = p.canGenerate and selectedStyle ~= nil
                    p.canExportXmp = p.idle and selectedStyle ~= nil and selectedStyle.canExportXmp == true
                    local batchRow = batchRows[p.batchPhotoChoice]
                    local batchIsOpen = currentBatch ~= nil and p.batchChoice == currentBatch.id
                    p.canPlanBatch = p.idle and selectedStyle ~= nil
                    p.canOpenBatch = p.idle and knownBatches[p.batchChoice] == true
                    p.canSelectBatchPhoto = p.idle and batchIsOpen
                    p.canOpenBatchPhoto = p.canSelectBatchPhoto and batchRow ~= nil and batchRow.jobId ~= nil
                    p.canPreviewBatch = p.canSelectBatchPhoto and not currentBatch.progress and currentBatch.previewable > 0
                    p.canOpenConversation = p.idle and conversationsById[p.conversationChoice] ~= nil
                    p.canOpenRevision = p.idle and p.revisionChoice ~= ''
                    p.canReadPrevious = historyPage > 1
                    p.canReadNext = historyPage < #historyPages
                end

                local function showHistoryPage(page)
                    historyPage = page
                    p.historyText = historyPages[page]
                    p.historyPosition = tostring(page) .. ' / ' .. tostring(#historyPages)
                    buttons()
                end

                local function setHistory(turns)
                    historyPages = {}
                    local selectedPage = 1
                    for _, turn in ipairs(turns) do
                        selectedPage = #historyPages + 1
                        local lines = {}
                        for line in (turn .. '\n'):gmatch('(.-)\n') do
                            local characters = {}
                            for character in line:gmatch('[%z\1-\127\194-\244][\128-\191]*') do
                                characters[#characters + 1] = character
                                if #characters == 42 then
                                    lines[#lines + 1] = table.concat(characters)
                                    characters = {}
                                end
                            end
                            if #characters > 0 or line == '' then lines[#lines + 1] = table.concat(characters) end
                        end
                        for first = 1, #lines, 5 do
                            historyPages[#historyPages + 1] = table.concat(lines, '\n', first, math.min(first + 4, #lines))
                        end
                    end
                    showHistoryPage(selectedPage)
                end

                local function failureText(job, reason)
                    local lines = { reason or job.error or '任务未完成。' }
                    if reason and job.error and reason ~= job.error then
                        table.insert(lines, '任务记录：' .. job.error)
                    end
                    if job.outcomeUnknown then
                        table.insert(lines, 1, 'Lightroom 可能仍在执行请求。请先检查副本和快照，再决定是否恢复。')
                        if job.copyId then table.insert(lines, 2, '副本 ID：' .. job.copyId) end
                        if job.recoveryError and job.recoveryError ~= reason then table.insert(lines, '恢复记录：' .. job.recoveryError) end
                    elseif job.recoveryError then
                        table.insert(lines, 1, '副本自动恢复失败，可能仍保留调整。')
                        table.insert(lines, 2, '需要恢复的副本 ID：' .. tostring(job.copyId or '未知'))
                        table.insert(lines, '恢复错误：' .. job.recoveryError)
                        table.insert(lines, '请先点击“恢复副本”；若仍失败，请在 Lightroom 中检查该副本。')
                    end
                    return table.concat(lines, '\n\n')
                end

                local function failureStatus(job)
                    if job.outcomeUnknown then return 'Lightroom 请求结果未知。请先在 Lightroom 中检查副本。' end
                    return job.recoveryError and '副本自动恢复失败，请先恢复副本并查看错误详情。' or '任务未完成，请查看“分析与适配”中的原因后重试。'
                end

                local function resumeStatus(job)
                    if job.status == 'failed' then return failureStatus(job) end
                    if job.status == 'restored' and not job.canRefine then return '副本已恢复。本轮没有可用的预览，可重新生成方案。' end
                    if job.status == 'previewed' and not job.canRefine then return '上次预览文件不可用，可重新生成方案。' end
                    if job.status == 'planned' and not hasChanges(job) then return '当前方案无参数变化。可以修改描述或强度后重新生成。' end
                    local states = {
                        captured = '已载入照片：选择调色方式并生成方案。',
                        planned = '已载入方案：检查参数差异后，点击“预览副本”。',
                        previewed = '预览已载入：可在“对话”继续调整，或保存风格、恢复副本。',
                        restored = '副本已恢复，右图保留上次预览。可继续调整或重新生成。',
                    }
                    return states[job.status] or '上次任务尚未完成，请检查任务记录与副本后重试。'
                end

                local function useJob(job)
                    applyingJob = true
                    currentJob = job
                    if job.hasPlan and job.request then
                        p.mode, p.prompt = job.request.mode, job.request.prompt
                        p.reference, p.strength = job.request.reference or '', job.request.strength * 100
                        p.localMasks = job.request.localMasks == true
                        prefs.mode, prefs.prompt, prefs.reference, prefs.strength = p.mode, p.prompt, p.reference, p.strength
                    end
                    p.photoId = job.photoId
                    p.photo = job.filename .. '  ·  照片 ' .. job.photoId .. '  ·  第 ' .. tostring(job.revision or 1) .. ' 轮'
                    p.beforePath = job.beforePath ~= '' and LrFileUtils.exists(job.beforePath) and job.beforePath or ''
                    p.afterPath = job.afterPath ~= '' and LrFileUtils.exists(job.afterPath) and job.afterPath or ''
                    if p.afterPath ~= '' then
                        p.afterTitle = job.status == 'restored' and '上次预览（副本已恢复）' or '副本预览'
                    elseif job.status == 'restored' then
                        p.afterTitle = '本轮没有可用的预览'
                    elseif job.status == 'previewed' then
                        p.afterTitle = '副本预览（文件不可用）'
                    elseif job.status == 'planned' and hasChanges(job) then
                        p.afterTitle = '副本预览（方案待预览）'
                    elseif job.status == 'failed' then
                        p.afterTitle = '副本预览（请查看任务状态）'
                    elseif job.status == 'planned' then
                        p.afterTitle = '副本预览（方案无变化）'
                    else
                        p.afterTitle = '副本预览（待生成方案）'
                    end
                    p.analysis = job.title .. '\n\n' .. (job.displayAnalysis or job.analysis)
                    if job.status == 'failed' then p.analysis = failureText(job) end
                    p.referencePreviewPath = job.referencePath and job.referencePath ~= '' and LrFileUtils.exists(job.referencePath) and job.referencePath or ''
                    local hasMaskSummary = job.maskSummary and job.maskSummary ~= ''
                    local emptyDiff = hasMaskSummary and '没有全局参数变化。' or '没有参数变化。'
                    local diff = job.displayDiff or job.diff
                    p.diff = diff ~= '' and diff or emptyDiff
                    if not job.hasPlan and job.status == 'captured' then p.diff = '生成方案后，这里显示预览副本将使用的参数。' end
                    if job.parentJobId then
                        local stepDiff = job.displayStepDiff or job.stepDiff
                        stepDiff = stepDiff and stepDiff ~= '' and stepDiff or emptyDiff
                        p.diff = '本轮调整（相对上一轮）：\n' .. stepDiff .. '\n\n累计调整（相对初始照片）：\n' .. p.diff
                    end
                    if hasMaskSummary then p.diff = '局部蒙版（累计）\n' .. job.maskSummary .. '\n\n' .. p.diff end
                    local conversationId = job.conversationId or job.id
                    p.conversationChoice = conversationsById[conversationId] and conversationId or ''
                    p.revisionChoice = job.id
                    if job.hasPlan then p.styleName = job.title end
                    prefs.lastJobId = job.id
                    local row = batchRows[job.photoId]
                    if row and row.jobId == job.id then p.batchPhotoChoice = row.photoId end
                    applyingJob = false
                    if currentBatch then showBatchPhoto() else buttons() end
                    if loadHistory then loadHistory(job) end
                end

                local statusNames = { captured = '已读取', planned = '待预览', previewed = '已预览', restored = '已恢复', failed = '未完成' }
                local batchStates = {
                    queued = '未开始', captured = '已读取', planned = '待预览', previewed = '已预览', restored = '已恢复', failed = '失败',
                    ['no-change'] = '无需调整', ['preview-failed'] = '预览未完成', ['creating-copy'] = '创建副本中断',
                    snapshotting = '建立快照中断', applying = '写入中断', rendering = '渲染中断', restoring = '恢复中断',
                }
                showBatchPhoto = function()
                    local row = batchRows[p.batchPhotoChoice]
                    local scope = '「预览副本」和「恢复副本」对应上方照片。'
                    if currentBatch and p.batchChoice ~= currentBatch.id then
                        p.batchDetail = '当前加载批次 ' .. string.sub(currentBatch.id, 1, 8) .. '。点击「打开批次」切换。\n' .. scope
                    elseif not currentBatch then
                        p.batchDetail = p.batchChoice ~= '' and '点击「打开批次」查看照片。' or '生成后可逐张查看方案。预览会为每张照片创建独立副本。'
                    elseif row and row.jobId and currentJob and row.jobId == currentJob.id then
                        p.batchDetail = row.detail or '上方显示此张照片的方案和预览。'
                    elseif row and row.jobId then
                        p.batchDetail = scope .. '\n' .. (row.detail or '点击「查看此张」切换上方对比。')
                    else
                        p.batchDetail = scope .. '\n' .. (row and row.detail or '此张暂无可查看的方案。')
                    end
                    buttons()
                end

                local function showBatch(batch)
                    local switching = not currentBatch or currentBatch.id ~= batch.id
                    currentBatch, batchRows = batch, {}
                    prefs.lastBatchId = batch.id
                    if knownBatches[batch.id] then p.batchChoice = batch.id end
                    local items, counts = {}, {}
                    for _, row in ipairs(batch.items) do
                        batchRows[row.photoId] = row
                        counts[row.status] = (counts[row.status] or 0) + 1
                        local title = (batchStates[row.status] or row.status) .. ' · ' .. (row.filename or '照片') .. ' · ' .. row.photoId
                        items[#items + 1] = { title = title, value = row.photoId }
                    end
                    p.batchPhotoItems = items
                    if switching or not batchRows[p.batchPhotoChoice] then
                        local activeRow = currentJob and batchRows[currentJob.photoId]
                        p.batchPhotoChoice = activeRow and activeRow.jobId == currentJob.id and activeRow.photoId or items[1].value
                    end
                    local summary = { #items .. ' 张', batch.previewable .. ' 张可预览' }
                    for _, status in ipairs { 'previewed', 'restored', 'no-change', 'failed', 'preview-failed' } do
                        if counts[status] then summary[#summary + 1] = counts[status] .. ' 张' .. batchStates[status] end
                    end
                    local count = table.concat(summary, ' · ')
                    local progress = batch.progress
                    if progress then
                        local step = progress.stage == 'planning' and '正在生成方案' or '正在预览副本'
                        p.batchMessage = step .. ' ' .. progress.current .. ' / ' .. progress.total .. ' · ' .. count
                    elseif batch.blockedByPhotoId then
                        p.batchMessage = '整批预览已停止。请检查照片 ' .. batch.blockedByPhotoId .. ' 的副本与恢复状态。'
                    else
                        local label = batch.state == 'stopped' and '生成已停止' or (batch.state == 'interrupted' and '上次生成中断' or '批次记录')
                        p.batchMessage = label .. ' · ' .. count .. '\n' .. batch.styleName .. ' · 强度 ' .. math.floor(batch.strength * 100 + 0.5) .. '%'
                    end
                    showBatchPhoto()
                end
                loadHistory = function(job)
                    LrTasks.startAsyncTask(function()
                        local ok, history = LrTasks.pcall(function() return Client.request('GET', '/conversations/' .. job.id) end)
                        if closed or not currentJob or currentJob.id ~= job.id then return end
                        if not ok then setHistory { '会话记录载入失败。' .. tostring(history) }; return end
                        local items, byId = {}, {}
                        for _, turn in ipairs(history.jobs or {}) do
                            byId[turn.id] = turn
                            table.insert(items, { title = '第 ' .. tostring(turn.revision or 1) .. ' 轮 · ' .. (statusNames[turn.status] or turn.status) .. ' · ' .. turn.title .. ' · ' .. string.sub(turn.id, 1, 8), value = turn.id })
                        end
                        local lineage, nextId, count = {}, job.id, 0
                        while nextId and byId[nextId] and count < 20 do
                            local turn = byId[nextId]
                            local direction = turn.direction or ''
                            if #direction > 1200 then
                                local lastByte = 1200
                                while lastByte > 0 and string.byte(direction, lastByte + 1) >= 128 and string.byte(direction, lastByte + 1) < 192 do lastByte = lastByte - 1 end
                                direction = string.sub(direction, 1, lastByte) .. '…'
                            end
                            table.insert(lineage, 1, '第 ' .. tostring(turn.revision or 1) .. ' 轮 · ' .. (statusNames[turn.status] or turn.status) .. '\n你：' .. direction .. '\nCodex：' .. (turn.error or turn.adaptation or turn.title))
                            nextId, count = turn.parentJobId, count + 1
                        end
                        p.revisionItems = #items > 0 and items or { { title = '暂无轮次', value = '' } }
                        p.revisionChoice = job.id
                        setHistory(#lineage > 0 and lineage or { '暂无对话记录。' })
                    end)
                end

                local function showSelectedStyle()
                    local style = stylesById[p.selectedStyle]
                    p.libraryReferencePath = style and style.referencePath ~= '' and LrFileUtils.exists(style.referencePath) and style.referencePath or ''
                    p.librarySummary = style and (style.name .. '\n' .. style.intent)
                        or '预览满意后保存风格。风格包含调色意图和参考图副本，应用时按新照片适配。'
                    p.xmpNote = style and not style.canExportXmp and '此风格没有可导出的 XMP 参数。' or xmpGuide
                    buttons()
                end

                refreshWorkspace = function(preferredName)
                    if p.listBusy then return end
                    p.listBusy = true; buttons()
                    LrTasks.startAsyncTask(function()
                        local ok, workspace = LrTasks.pcall(function() return Client.request('GET', '/workspace') end)
                        p.listBusy = false
                        if closed then return end
                        if ok then
                            local conversations, styles = {}, {}
                            stylesById, conversationsById = {}, {}
                            for _, conversation in ipairs(workspace.conversations or {}) do
                                conversationsById[conversation.id] = conversation
                                table.insert(conversations, { title = conversation.filename .. ' · ' .. conversation.title .. ' · ' .. string.sub(conversation.id, 1, 8), value = conversation.id })
                            end
                            for _, style in ipairs(workspace.styles or {}) do
                                stylesById[style.id] = style
                                table.insert(styles, { title = style.name .. (style.hasReference and ' · 参考图' or ' · 文字') .. ' · ' .. string.sub(style.id, 1, 8), value = style.id })
                            end
                            if #conversations > 0 then table.insert(conversations, 1, { title = '选择历史会话…', value = '' }) end
                            p.conversationItems = #conversations > 0 and conversations or { { title = '暂无会话', value = '' } }
                            if not conversationsById[p.conversationChoice] then
                                local currentId = currentJob and (currentJob.conversationId or currentJob.id)
                                p.conversationChoice = currentId and conversationsById[currentId] and currentId or ''
                            end
                            p.styleItems = #styles > 0 and styles or { { title = '尚无已保存风格', value = '' } }
                            if not stylesById[p.selectedStyle] then p.selectedStyle = styles[1] and styles[1].value or '' end
                            if preferredName then
                                for _, item in ipairs(styles) do if stylesById[item.value].name == preferredName then p.selectedStyle = item.value; break end end
                            end
                            showSelectedStyle()
                            local batches = { { title = '选择历史批次…', value = '' } }
                            knownBatches = {}
                            for _, batch in ipairs(workspace.batches or {}) do
                                knownBatches[batch.id] = true
                                batches[#batches + 1] = { title = string.sub(batch.id, 1, 8) .. ' · ' .. batch.total .. ' 张 · ' .. batch.styleName, value = batch.id }
                            end
                            p.batchItems = #batches > 1 and batches or { { title = '暂无批次', value = '' } }
                            if currentBatch and knownBatches[currentBatch.id] then p.batchChoice = currentBatch.id
                            elseif not knownBatches[p.batchChoice] then p.batchChoice = '' end
                            if not currentBatch and prefs.lastBatchId and p.idle then openBatch(prefs.lastBatchId, true) end
                        else
                            p.status = '会话和风格库暂不可用，请启动 Host 后刷新。'
                            setHistory { tostring(workspace) }
                        end
                        buttons()
                    end)
                end

                openBatch = function(id, quiet)
                    if not p.idle or not id or id == '' then return end
                    p.loading = true; buttons()
                    LrTasks.startAsyncTask(function()
                        local ok, batch = LrTasks.pcall(function() return Client.request('GET', '/batches/' .. id) end)
                        p.loading = false
                        if closed then return end
                        if ok then showBatch(batch)
                        elseif not quiet then p.batchMessage = tostring(batch) end
                        buttons()
                    end)
                end

                local function openJob(id)
                    if not p.idle or not id or id == '' then return end
                    p.loading = true; buttons()
                    LrTasks.startAsyncTask(function()
                        local ok, job = LrTasks.pcall(function() return Client.request('GET', '/jobs/' .. id) end)
                        p.loading = false
                        if closed then return end
                        if ok then
                            useJob(job); p.status = resumeStatus(job)
                            if job.status == 'failed' then p.detailTab = 'analysis' end
                        else
                            p.status = '会话载入失败，请刷新后重试。'; p.analysis = tostring(job); p.detailTab = 'analysis'
                        end
                        buttons()
                    end)
                end

                local function newConversation()
                    if not p.idle then return end
                    currentJob, prefs.lastJobId = nil, nil
                    p.localMasks = false
                    p.photoId, p.beforePath, p.afterPath = nil, '', ''
                    p.photo, p.afterTitle = '请在 Lightroom 中选中一张照片。', '副本预览（待读取照片）'
                    p.analysis, p.diff = '生成方案后查看分析。', '尚无参数方案。'
                    p.feedback = ''
                    setHistory { '新会话已开始。可从上方列表打开历史会话。' }
                    p.revisionItems, p.revisionChoice = { { title = '暂无轮次', value = '' } }, ''
                    p.conversationChoice = ''
                    p.status = '新会话：读取选中照片后生成方案。'
                    p.detailTab = 'diff'
                    if currentBatch then showBatchPhoto() else buttons() end
                end

                p:addObserver('selectedStyle', showSelectedStyle)
                p:addObserver('conversationChoice', buttons)
                p:addObserver('revisionChoice', buttons)
                p:addObserver('feedback', buttons)
                p:addObserver('batchChoice', showBatchPhoto)
                p:addObserver('batchPhotoChoice', showBatchPhoto)

                local labels = { capture = '正在读取 Lightroom 照片与预览…', generate = 'Codex 正在分析照片并生成方案…', preview = '正在创建副本并由 Lightroom 渲染…', restore = '正在恢复该任务的虚拟副本…', refine = '正在准备上一轮结果…', ['save-style'] = '正在保存调色意图和参考图副本…', ['apply-style'] = '正在为当前照片适配风格…' }
                labels['batch-plan'], labels['batch-preview'] = '正在逐张生成批次方案…', '正在逐张创建批次预览副本…'
                local function run(action, body)
                    if not p.idle then return end
                    local batchAction = action == 'batch-plan' or action == 'batch-preview'
                    p.busy = true
                    buttons()
                    p.status = labels[action]
                    if batchAction then p.batchMessage = labels[action] end
                    LrTasks.startAsyncTask(function()
                        local succeeded, result = LrTasks.pcall(function()
                            body = body or {}
                            body.action = action
                            local task = Client.request('POST', '/tasks', body)
                            while task.state == 'running' do
                                if closed then
                                    if task.cancellable then Client.request('POST', '/cancel', {}) end
                                    return nil
                                end
                                p.canCancel = task.cancellable == true
                                p.status = labels[task.stage] or '正在处理…'
                                if task.batch then showBatch(task.batch) end
                                LrTasks.sleep(0.6)
                                task = Client.request('GET', '/tasks/' .. task.id)
                            end
                            if task.job then useJob(task.job) end
                            if task.batch and not closed then showBatch(task.batch) end
                            if task.state == 'failed' then error(task.error or '任务失败，请重试。', 0) end
                            return task.batch or task.job
                        end)
                        p.busy, p.canCancel = false, false
                        buttons()
                        if not closed then
                            if not succeeded then
                                if batchAction then
                                    p.status = '批次操作未完成，请查看「批量」中的提示。'
                                    p.batchMessage = tostring(result)
                                else
                                    local failedJob = currentJob or {}
                                    p.status = failureStatus(failedJob)
                                    p.analysis = failureText(failedJob, tostring(result))
                                    p.detailTab = 'analysis'
                                end
                            elseif result then
                                if action == 'batch-plan' then
                                    p.status = result.state == 'stopped' and '生成已停止。已完成的方案保留在「批量」。' or '生成已结束。可在「批量」逐张查看结果。'
                                elseif action == 'batch-preview' then
                                    p.status = result.blockedByPhotoId and '整批预览已停止，请检查「批量」中的恢复状态。' or '预览已结束。请在「批量」查看各张照片的状态。'
                                    if currentJob then
                                        for _, row in ipairs(result.items) do
                                            if row.jobId == currentJob.id then openJob(currentJob.id); break end
                                        end
                                    end
                                elseif action == 'preview' then p.status = '预览已生成：请比较左右图。仅新虚拟副本被修改。'
                                elseif action == 'restore' then p.status = resumeStatus(result)
                                elseif action == 'save-style' then p.status = '风格已保存：' .. body.name
                                elseif action == 'generate' or action == 'refine' or action == 'apply-style' then
                                    p.status = resumeStatus(result)
                                    p.detailTab = 'diff'
                                    if action == 'refine' then p.feedback = '' end
                                else p.status = '照片已读取：选择调色方式并生成方案。' end
                            end
                            if currentBatch and (action == 'preview' or action == 'restore') then openBatch(currentBatch.id, true) end
                            refreshWorkspace(action == 'save-style' and body.name or nil)
                        end
                    end)
                end

                local function planBatch()
                    if not p.canPlanBatch then return end
                    local catalog = LrApplication.activeCatalog()
                    local selected = catalog:getTargetPhoto() and catalog:getTargetPhotos() or {}
                    if #selected < 2 or #selected > 8 then
                        p.batchMessage = '请在 Lightroom 中选择 2–8 张照片。当前选择 ' .. #selected .. ' 张。'
                        return
                    end
                    local ids = {}
                    for _, photo in ipairs(selected) do ids[#ids + 1] = tostring(photo.localIdentifier) end
                    run('batch-plan', { photoIds = ids, styleId = p.selectedStyle, strength = p.strength / 100 })
                end

                local function readSelected()
                    local catalog = LrApplication.activeCatalog()
                    local target = catalog:getTargetPhoto()
                    if not target or #catalog:getTargetPhotos() ~= 1 then
                        p.status = '请在 Lightroom 中仅选中一张照片，再点击读取。'
                        return
                    end
                    run('capture', { photoId = tostring(target.localIdentifier) })
                end

                local function exportXmp()
                    if not p.canExportXmp then return end
                    local styleId = p.selectedStyle
                    p.loading = true; buttons()
                    LrTasks.startAsyncTask(function()
                        local ok, result = LrTasks.pcall(function()
                            local output = LrDialogs.runSavePanel { title = '导出 XMP 预设', prompt = '导出', requiredFileType = 'xmp', canCreateDirectories = true }
                            if not output or closed then return nil end
                            p.xmpNote = '正在导出 XMP…'
                            return Client.request('POST', '/styles/' .. styleId .. '/xmp', { output = output })
                        end)
                        if closed then return end
                        p.loading = false; buttons()
                        if not ok then
                            p.xmpNote = tostring(result)
                            p.status = 'XMP 导出失败，请查看风格库中的提示。'
                        elseif result then
                            p.xmpNote = '已导出 ' .. tostring(#result.keys) .. ' 项参数。可在 Lightroom 预设面板导入。'
                            p.status = 'XMP 预设已保存。'
                        end
                    end)
                end

                local function inputsChanged()
                    if applyingJob then return end
                    prefs.mode, prefs.prompt, prefs.reference, prefs.strength = p.mode, p.prompt, p.reference, p.strength
                    p.referencePreviewPath = p.mode == 'reference' and p.reference ~= '' and LrFileUtils.exists(p.reference) and p.reference or ''
                    if not p.busy and currentJob and currentJob.status == 'planned' then
                        currentJob = nil
                        prefs.lastJobId = nil
                        p.diff = '输入已变更，请重新生成方案。'
                        p.afterTitle = '副本预览（待重新生成）'
                        p.status = '请重新生成，使参数方案与当前输入一致。'
                    end
                    buttons()
                end
                for _, key in ipairs({ 'mode', 'prompt', 'reference', 'strength' }) do p:addObserver(key, inputsChanged) end
                p:addObserver('localMasks', inputsChanged)

                local function comparisonPane(pathKey, imageKey, emptyKey, label)
                    return f:view { place = 'overlapping', width = 326, height = 230,
                        f:static_text { title = label, visible = bind(emptyKey), width = 326, alignment = 'center', place_vertical = 0.5 },
                        f:picture { value = bind(pathKey), visible = bind(imageKey), width = 326, height = 230, frame_width = 1 },
                    }
                end

                local contents = f:column {
                    bind_to_object = p, spacing = 8, margin = 16,
                    f:row {
                        spacing = 8,
                        f:push_button { title = '读取选中照片', enabled = bind 'idle', action = readSelected },
                        f:static_text { title = bind 'photo', width = 530, height_in_lines = 1, truncation = 'middle' },
                    },
                    f:row {
                        spacing = 12,
                        f:column {
                            f:static_text { title = '源照片', width = 326, font = '<system/bold>' },
                            comparisonPane('beforePath', 'hasBefore', 'beforeEmpty', '在 Lightroom 选中照片后，点击「读取选中照片」。'),
                        },
                        f:column {
                            f:static_text { title = bind 'afterTitle', width = 326, font = '<system/bold>' },
                            comparisonPane('afterPath', 'hasAfter', 'afterEmpty', bind 'previewGuide'),
                        },
                    },
                    f:row {
                        spacing = 10,
                        f:static_text { title = '调色方式', width = 66 },
                        f:popup_menu { value = bind 'mode', enabled = bind 'idle', width = 200, items = {
                            { title = '文字描述', value = 'describe' },
                            { title = '参考图模拟', value = 'reference' },
                            { title = '自动调色', value = 'lucky' },
                        } },
                        f:static_text { title = '风格强度', width = 66 },
                        f:slider { value = bind 'strength', enabled = bind 'idle', min = 0, max = 100, integral = true, width = 180 },
                        f:edit_field { value = bind 'strength', enabled = bind 'idle', min = 0, max = 100, precision = 0, width_in_chars = 4 },
                        f:static_text { title = '%' },
                    },
                    f:row {
                        f:static_text { title = '参考图片', width = 66 },
                        f:edit_field { value = bind 'reference', enabled = bind 'canEditReference', width = 484, tooltip = '使用参考图模拟时可输入图片路径。' },
                        f:push_button { title = '选择图片…', enabled = bind 'idle', action = function()
                            local files = LrDialogs.runOpenPanel { title = '选择参考图片', canChooseFiles = true, canChooseDirectories = false, allowsMultipleSelection = false, fileTypes = { 'jpg', 'jpeg', 'png', 'webp' } }
                            if files and files[1] then p.reference = files[1]; p.mode = 'reference' end
                        end },
                    },
                    f:row { spacing = 8,
                        f:static_text { title = '风格描述', width = 66 },
                        f:edit_field { value = bind 'prompt', enabled = bind 'idle', width = 410, height_in_lines = 2, immediate = true },
                        f:column { spacing = 2,
                            f:checkbox { title = '局部蒙版与肤色保护', value = bind 'localMasks', enabled = bind 'idle', tooltip = '允许本轮提议主体或天空蒙版，并对可见或不确定的肤色限制红橙 HSL。取消勾选仍会继承已生成的蒙版。' },
                            f:static_text { title = bind 'maskHint', width = 170 },
                        },
                    },
                    f:row {
                        spacing = 8,
                        f:push_button { title = '生成方案', enabled = bind 'canGenerate', action = function()
                            if not p.photoId then return end
                            run('generate', { photoId = p.photoId, request = { mode = p.mode, prompt = p.prompt, reference = p.mode == 'reference' and p.reference ~= '' and p.reference or nil, strength = p.strength / 100, localMasks = p.localMasks == true } })
                        end },
                        f:push_button { title = '预览副本', enabled = bind 'canPreview', action = function() if currentJob then run('preview', { jobId = currentJob.id }) end end },
                        f:spacer { width = 16 },
                        f:push_button { title = '停止生成', enabled = bind 'canCancel', action = function()
                            LrTasks.startAsyncTask(function()
                                local stopped, reason = LrTasks.pcall(function() Client.request('POST', '/cancel', {}) end)
                                if not closed then p.status = stopped and '正在停止生成…' or tostring(reason) end
                            end)
                        end },
                        f:push_button { title = '恢复副本', enabled = bind 'canRestore', action = function() if currentJob then run('restore', { jobId = currentJob.id }) end end },
                    },
                    f:static_text { title = bind 'status', width = 668, height_in_lines = 2, font = '<system/bold>' },
                    f:tab_view { value = bind 'detailTab',
                        f:tab_view_item { title = '参数差异', identifier = 'diff',
                            f:scrolled_view { width = 658, height = 180, horizontal_scroller = false,
                                f:static_text { title = bind 'diff', width = 630, height_in_lines = 60 },
                            },
                        },
                        f:tab_view_item { title = '分析与适配', identifier = 'analysis',
                            f:scrolled_view { width = 658, height = 180, horizontal_scroller = false,
                                f:static_text { title = bind 'analysis', width = 630, height_in_lines = 36 },
                            },
                        },
                        f:tab_view_item { title = '对话', identifier = 'conversation',
                            f:column { spacing = 8,
                                f:row { spacing = 6,
                                    f:popup_menu { value = bind 'revisionChoice', items = bind 'revisionItems', width = 392, enabled = bind 'idle' },
                                    f:push_button { title = '查看此轮', enabled = bind 'canOpenRevision', action = function() openJob(p.revisionChoice) end },
                                    f:push_button { title = '上页', enabled = bind 'canReadPrevious', action = function() showHistoryPage(historyPage - 1) end },
                                    f:static_text { title = bind 'historyPosition', width = 48 },
                                    f:push_button { title = '下页', enabled = bind 'canReadNext', action = function() showHistoryPage(historyPage + 1) end },
                                },
                                f:static_text { title = bind 'historyText', width = 658, height_in_lines = 5 },
                                f:row {
                                    f:static_text { title = '调整意见', width = 66 },
                                    f:edit_field { value = bind 'feedback', width = 588, height_in_lines = 2, enabled = bind 'idle', immediate = true },
                                },
                                f:row { spacing = 10,
                                    f:push_button { title = '继续调整', enabled = bind 'canSubmitRefine', action = function() if p.canSubmitRefine then run('refine', { jobId = currentJob.id, feedback = p.feedback, strength = p.strength / 100, localMasks = p.localMasks == true }) end end },
                                    f:static_text { title = '先预览上一轮，再填写调整意见。每轮预览使用新副本。', width = 540 },
                                },
                            },
                        },
                        f:tab_view_item { title = '参考图片', identifier = 'reference',
                            f:row {
                                spacing = 12,
                                f:picture { value = bind 'referencePreviewPath', width = 180, height = 120 },
                                f:static_text { title = '参考图提供颜色与影调关系。\n曝光、白平衡及风格强度依据目标照片适配。', width = 440, height_in_lines = 4 },
                            },
                        },
                        f:tab_view_item { title = '风格库', identifier = 'styles',
                            f:column { spacing = 8,
                                f:row { spacing = 8,
                                    f:popup_menu { value = bind 'selectedStyle', items = bind 'styleItems', width = 430, enabled = bind 'idle' },
                                    f:push_button { title = '适配此风格', enabled = bind 'canApplyStyle', action = function() run('apply-style', { photoId = p.photoId, styleId = p.selectedStyle, strength = p.strength / 100, localMasks = p.localMasks == true }) end },
                                    f:push_button { title = '导出 XMP…', enabled = bind 'canExportXmp', action = exportXmp },
                                },
                                f:row { spacing = 12,
                                    f:picture { value = bind 'libraryReferencePath', width = 120, height = 80 },
                                    f:scrolled_view { width = 526, height = 80, horizontal_scroller = false,
                                        f:static_text { title = bind 'librarySummary', width = 500, height_in_lines = 400 },
                                    },
                                },
                                f:row {
                                    f:static_text { title = '保存名称', width = 66 },
                                    f:edit_field { value = bind 'styleName', width = 418, enabled = bind 'idle', immediate = true },
                                    f:push_button { title = '保存当前风格', enabled = bind 'canSaveStyle', action = function() if currentJob then run('save-style', { jobId = currentJob.id, name = p.styleName }) end end },
                                },
                                f:static_text { title = bind 'xmpNote', width = 658, height_in_lines = 2 },
                            },
                        },
                        f:tab_view_item { title = '批量', identifier = 'batch',
                            f:column { spacing = 8,
                                f:row { spacing = 8,
                                    f:static_text { title = '使用风格', width = 66 },
                                    f:popup_menu { value = bind 'selectedStyle', items = bind 'styleItems', width = 430, enabled = bind 'idle' },
                                    f:push_button { title = '为所选照片生成', enabled = bind 'canPlanBatch', action = planBatch },
                                },
                                f:row { spacing = 8,
                                    f:static_text { title = '历史批次', width = 66 },
                                    f:popup_menu { value = bind 'batchChoice', items = bind 'batchItems', width = 430, enabled = bind 'idle' },
                                    f:push_button { title = '打开批次', enabled = bind 'canOpenBatch', action = function() openBatch(p.batchChoice) end },
                                },
                                f:row { spacing = 8,
                                    f:static_text { title = '批次照片', width = 66 },
                                    f:popup_menu { value = bind 'batchPhotoChoice', items = bind 'batchPhotoItems', width = 430, enabled = bind 'canSelectBatchPhoto' },
                                    f:push_button { title = '查看此张', enabled = bind 'canOpenBatchPhoto', action = function() if p.canOpenBatchPhoto then openJob(batchRows[p.batchPhotoChoice].jobId) end end },
                                    f:push_button { title = '预览本批方案', enabled = bind 'canPreviewBatch', action = function() if p.canPreviewBatch then run('batch-preview', { batchId = currentBatch.id }) end end },
                                },
                                f:static_text { title = bind 'batchMessage', width = 658, height_in_lines = 2 },
                                f:static_text { title = bind 'batchDetail', width = 658, height_in_lines = 2 },
                            },
                        },
                    },
                    f:row {
                        spacing = 8,
                        f:static_text { title = '历史会话', width = 66 },
                        f:popup_menu { value = bind 'conversationChoice', items = bind 'conversationItems', width = 370, enabled = bind 'idle' },
                        f:push_button { title = '打开', enabled = bind 'canOpenConversation', action = function() local conversation = conversationsById[p.conversationChoice]; if conversation then openJob(conversation.headJobId) end end },
                        f:push_button { title = '刷新', enabled = bind 'idle', action = refreshWorkspace },
                        f:push_button { title = '新会话', enabled = bind 'idle', action = newConversation },
                    },
                }

                if prefs.lastJobId then
                    LrTasks.startAsyncTask(function()
                        local loaded, job = LrTasks.pcall(function() return Client.request('GET', '/jobs/' .. prefs.lastJobId) end)
                        if loaded and not closed and not p.busy and not currentJob then
                            useJob(job)
                            p.status = resumeStatus(job)
                            if job.status == 'failed' then p.detailTab = 'analysis' end
                        elseif not loaded and not closed and not p.busy then
                            p.status = '上次任务暂未载入，可从会话列表打开或重新读取照片。'
                            setHistory { tostring(job) }
                        end
                    end)
                end
                refreshWorkspace()
                LrDialogs.presentFloatingDialog(_PLUGIN, {
                    title = 'LR Codex Studio', contents = contents,
                    blockTask = true,
                    save_frame = 'studioWindowFrame',
                    onShow = function(controls) _G.LRCodexStudio_ToFront = controls.toFront end,
                    windowWillClose = function()
                        closed = true
                        _G.LRCodexStudio_WindowOpen = false
                        _G.LRCodexStudio_ToFront = nil
                    end,
                })
            end)
        end)
        _G.LRCodexStudio_WindowOpen = false
        if not ok then LrDialogs.message('LR Codex Studio', tostring(failure), 'critical') end
    end)
end

return Window
