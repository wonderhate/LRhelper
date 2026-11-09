"""Lua 5.1 syntax and UI-controller contract checks with SDK stubs.

Run from the repository root after installing lupa in .studio/qa-python.
This is separate from full Busted / live Lightroom UI validation.
"""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / ".studio/qa-python"))
from lupa.lua51 import LuaRuntime

BOOT = r'''
queue = {}
function enqueue(fn) queue[#queue+1] = coroutine.create(fn) end
function step()
    local items = queue; queue = {}
    for _, co in ipairs(items) do
        local ok, err = coroutine.resume(co)
        if not ok then error(err) end
        if coroutine.status(co) ~= 'dead' then queue[#queue+1] = co end
    end
end
local factory = setmetatable({}, { __index = function(_, kind)
    return function(_, item) item.kind = kind; return item end
end })
local property
preferences = {}
local function yieldablePcall(fn)
    local co = coroutine.create(fn)
    while true do
        local result = {coroutine.resume(co)}
        if not result[1] or coroutine.status(co) == 'dead' then return unpack(result) end
        coroutine.yield()
    end
end
local function properties()
    local values, observers = {}, {}
    local proxy = setmetatable({}, {
        __index = function(_, k) return values[k] end,
        __newindex = function(_, k, v)
            local old = values[k]; values[k] = v
            if old ~= v and observers[k] then observers[k]() end
        end,
    })
    function proxy:addObserver(key, fn) observers[key] = fn end
    property = proxy
    return proxy
end
function props() return property end
local sdk = {
    LrApplication = { activeCatalog = function() return {
        getTargetPhoto = function() return {localIdentifier=1} end,
        getTargetPhotos = function() return selectedPhotos or {{localIdentifier=1}} end,
    } end },
    LrBinding = {makePropertyTable = properties},
    LrDialogs = {message = function(title, message) lastError = message end,
        presentFloatingDialog = function(_, options)
            dialog = options
            assert(options.blockTask == true)
            assert(type(options.windowWillClose) == 'function')
            if options.onShow then options.onShow({toFront=function() broughtToFront=true end}) end
            while _G.LRCodexStudio_WindowOpen do coroutine.yield() end
        end,
        runOpenPanel = function() return nil end,
        confirm = function() return storageConfirmation or 'cancel' end,
        runSavePanel = function(options) assert(options.requiredFileType == 'xmp'); return savePanelPath end},
    LrFileUtils = {exists = function(file) return file ~= '' end},
    LrFunctionContext = {callWithContext = function(_, fn) fn({}) end},
    LrPrefs = {prefsForPlugin = function() return preferences end},
    LrTasks = {startAsyncTask=enqueue, pcall=yieldablePcall, sleep=function() coroutine.yield() end},
    LrView = {osFactory=function() return factory end, bind=function(key) return {key=key} end},
}
function import(name) return sdk[name] end
_PLUGIN = {}
clientCalls = {}
local nextAction
local savedJob
function currentSavedJob() return savedJob end
savedStyles = {}
local function job(status)
    return {id='00000000-0000-0000-0000-000000000001',photoId='1',filename='test.raw',status=status,
        title='Test',analysis='Target-specific plan',diff=status=='captured' and '' or 'Exposure2012: 0 -> 0.2',
        beforePath='before.jpg',afterPath=(status=='previewed' or status=='restored') and 'after.jpg' or '',canRestore=status=='previewed',
        hasPlan=status~='captured',request={mode='describe',prompt='saved',strength=0.65},referencePath='',
        conversationId='00000000-0000-0000-0000-000000000001',revision=1,canRefine=status=='previewed' or status=='restored'}
end
package.loaded.StudioClient = {request=function(method, route, body)
    clientCalls[#clientCalls+1] = {method=method,route=route,body=body}
    if offline then error('Host offline') end
    if route=='/tasks' then nextAction=body.action;return {id='task',state='running',stage=body.action} end
    if route=='/tasks/task' then
        pollCount=(pollCount or 0)+1
        if pollCount==pollFailureAt then error('Poll timed out') end
        if pollCount<=(pollWaits or 0) then return {id='task',state='running',stage=nextAction,cancellable=true} end
    end
    if route=='/cancel' then return {ok=true} end
    if route=='/storage' then
        if method=='GET' then return {jobs={bytes=2048},styles={bytes=0},batches={bytes=0},trash={bytes=0},archives={}} end
        if body.action=='inspect' then return {records=1,images=1,bytes=2048} end
        if body.action=='trash' then return {records=1,images=1,bytes=2048} end
    end
    if route:find('^/styles/.-/xmp$') then return {path=body.output,keys={'Shadows2012'}} end
    if route:find('^/jobs/') then return recoveryJob or savedJob end
    if route:find('^/batches/') then return savedBatch end
    if route=='/workspace' then
        local batches = savedBatch and {{id=savedBatch.id,styleName=savedBatch.styleName,total=#savedBatch.items}} or {}
        if otherBatch then batches[#batches+1] = otherBatch end
        return {conversations=savedJob and savedJob.status~='captured' and {{id=savedJob.conversationId or savedJob.id,headJobId=savedJob.id,title='Saved',filename='test.raw'}} or {},styles=savedStyles,batches=batches}
    end
    if route:find('^/conversations/') then
        if historyJobs then return {jobs=historyJobs} end
        return {jobs=savedJob and {{id=savedJob.id,revision=savedJob.revision,status=savedJob.status,title=savedJob.title,direction='saved',adaptation='adapted'}} or {}}
    end
    if nextAction=='save-style' then
        savedStyles={{id='00000000-0000-0000-0000-000000000002',name=clientCalls[#clientCalls-1].body.name,intent='soft',hasReference=true,referencePath='owned-reference.jpg',strength=0.65}}
        return {id='task',state='completed',job=savedJob}
    end
    if nextAction=='batch-plan' then
        savedJob=job('planned')
        savedBatch={id='00000000-0000-0000-0000-000000000008', styleName='海岸',strength=0.65,state='finished',previewable=1,
            items={{photoId='1',jobId=savedJob.id,filename='test.raw',status='planned'},{photoId='2',status='failed',detail='照片离线'}}}
        return {id='task',state='completed',batch=savedBatch}
    end
    if nextAction=='batch-preview' then
        savedJob=job('previewed'); savedBatch.items[1].status='previewed'; savedBatch.previewable=0
        return {id='task',state='completed',batch=savedBatch}
    end
    local status = ({capture='captured',generate='planned',preview='previewed',restore='restored',refine='planned',['apply-style']='planned'})[nextAction]
    savedJob=job(status)
    if nextAction=='preview' and failRecovery then
        savedJob.status='failed';savedJob.copyId='77';savedJob.canRestore=true
        savedJob.error='write failed';savedJob.recoveryError='rollback failed'
        return {id='task',state='failed',job=savedJob,error='write failed'}
    end
    return {id='task',state='completed',job=savedJob}
end}
function button(title)
    local function walk(item)
        if item.kind=='push_button' and item.title==title then return item end
        for _, child in ipairs(item) do if type(child)=='table' then local found=walk(child);if found then return found end end end
    end
    return walk(dialog.contents)
end
'''


class WorkbenchLuaTests(unittest.TestCase):
    def setUp(self):
        self.lua = LuaRuntime(unpack_returned_tuples=True)
        self.lua.execute(BOOT)
        base = (ROOT / "plugin/LRCodexStudio.lrplugin").as_posix()
        self.lua.execute(f"package.path = {base!r} .. '/?.lua;' .. package.path")
        self.lua.execute("require('StudioWindow').show(); step()")

    def run_lua(self, code):
        self.lua.execute(code)

    def test_all_files_parse_in_lua51(self):
        parse = self.lua.eval("function(s,n) local f,e=loadstring(s,n);return f~=nil,e end")
        for file in (ROOT / "plugin/LRCodexStudio.lrplugin").glob("*.lua"):
            ok, error = parse(file.read_text(encoding="utf-8"), file.name)
            self.assertTrue(ok, error)

    def test_empty_and_capture_states(self):
        self.run_lua("assert(dialog);assert(not props().canPreview);button('读取选中照片').action();step();step();step();assert(props().canGenerate);assert(not props().canPreview);assert(props().photoId=='1');assert(props().conversationChoice=='');assert(not props().canOpenConversation)")

    def test_generate_pins_photo_and_input_changes_invalidate_preview(self):
        self.run_lua("button('读取选中照片').action();step();step();props().prompt='soft';button('生成方案').action();step();step();assert(props().canPreview);local sent;for _,call in ipairs(clientCalls) do if call.body and call.body.action=='generate' then sent=call end end;assert(sent.body.photoId=='1');props().strength=20;assert(not props().canPreview)")

    def test_plan_and_error_open_the_relevant_tab(self):
        self.run_lua(r'''
            button('读取选中照片').action(); step(); step()
            assert(not props().canEditReference and props().afterTitle:find('待生成方案'))
            props().mode='reference'; assert(props().canEditReference)
            props().mode='describe'; props().detailTab='conversation'; props().prompt='soft'
            button('生成方案').action(); step(); step()
            assert(props().detailTab=='diff' and props().afterTitle:find('方案待预览'))
            offline=true; button('读取选中照片').action(); step()
            assert(props().detailTab=='analysis')
        ''')

    def test_preview_then_restore_has_explicit_status(self):
        self.run_lua("button('读取选中照片').action();step();step();props().prompt='soft';button('生成方案').action();step();step();button('预览副本').action();step();step();assert(props().canRestore);button('恢复副本').action();step();step();assert(props().afterTitle=='上次预览（副本已恢复）');dialog.windowWillClose();step();require('StudioWindow').show();step();step();assert(props().status:find('副本已恢复'));assert(props().status:find('重新生成'));assert(not props().canPreview)")

    def test_offline_error_and_window_cleanup(self):
        self.run_lua("offline=true;button('读取选中照片').action();step();assert(not props().busy);assert(props().analysis:find('Host offline'));dialog.windowWillClose();step();assert(not _G.LRCodexStudio_WindowOpen)")

    def test_second_poll_timeout_reconnects_and_reopening_keeps_the_same_task(self):
        self.run_lua(r'''
            pollWaits=2;pollFailureAt=2
            button('读取选中照片').action()
            step();step();step()
            assert(props().busy and props().status:find('重新连接'))
            assert(preferences.pendingTaskId=='task')
            dialog.windowWillClose();step();require('StudioWindow').show()
            step();step();step();step()
            assert(not props().busy and props().photoId=='1')
            assert(preferences.pendingTaskId==nil)
            local submissions=0
            for _,call in ipairs(clientCalls) do
                if call.route=='/tasks' then submissions=submissions+1 end
                assert(call.route~='/cancel')
            end
            assert(submissions==1)
        ''')

    def test_storage_counts_and_confirms_before_moving_a_record(self):
        self.run_lua(r'''
            button('读取选中照片').action();step();step()
            props().prompt='soft';button('生成方案').action();step();step();step()
            props().storageId=currentSavedJob().id
            button('查看容量').action();step()
            assert(props().storageSummary:find('2.0 KB',1,true))
            button('移到回收站').action();step()
            for _,call in ipairs(clientCalls) do assert(not call.body or call.body.action~='trash') end
            storageConfirmation='ok'
            button('移到回收站').action();step()
            assert(props().storageMessage=='已移到回收站。')
            local count=0
            for _,call in ipairs(clientCalls) do
                if call.body and call.body.action=='trash' then count=count+1 end
            end
            assert(count==1)
        ''')

    def test_existing_dialog_is_brought_to_front_and_can_reopen_after_close(self):
        self.run_lua("require('StudioWindow').show();assert(broughtToFront);dialog.windowWillClose();step();require('StudioWindow').show();step();assert(_G.LRCodexStudio_WindowOpen)")

    def test_changed_plan_does_not_resurrect_on_reopen(self):
        self.run_lua("button('读取选中照片').action();step();step();props().prompt='soft';button('生成方案').action();step();step();assert(preferences.lastJobId);props().strength=20;assert(preferences.lastJobId==nil);dialog.windowWillClose();step();require('StudioWindow').show();step();assert(props().strength==20);assert(not props().canPreview)")

    def test_recovered_plan_rebinds_inputs_and_reference_under_guard(self):
        self.run_lua("button('读取选中照片').action();step();step();props().prompt='soft';button('生成方案').action();step();step();dialog.windowWillClose();step();preferences.strength=20;preferences.prompt='different';require('StudioWindow').show();step();step();assert(props().strength==65);assert(props().prompt=='saved');assert(props().canPreview)")

    def test_local_plan_preserves_step_diff_and_explains_inherited_masks(self):
        self.run_lua(r'''
            assert(props().localMasks == false)
            button('读取选中照片').action(); step(); step()
            props().prompt='only sky'; props().localMasks=true
            button('生成方案').action(); step(); step()
            local sent
            for _, call in ipairs(clientCalls) do
                if call.body and call.body.action=='generate' then sent=call end
            end
            assert(sent and sent.body.request.localMasks == true)
            dialog.windowWillClose(); step()
            recoveryJob={id=preferences.lastJobId,status='planned',photoId='1',filename='test.raw',title='sky',analysis='',
                beforePath='before.jpg',afterPath='',hasPlan=true,request={mode='describe',prompt='only sky',strength=0.65,localMasks=true}}
            recoveryJob.parentJobId=recoveryJob.id; recoveryJob.diff=''; recoveryJob.stepDiff='Exposure2012: 0.2 → 0'
            recoveryJob.hasMaskChanges=true; recoveryJob.maskSummary='天空 · 高光 -10'
            require('StudioWindow').show(); step(); step()
            assert(props().localMasks and props().canPreview)
            assert(props().diff:find('天空') and props().diff:find('Exposure2012',1,true))
            assert(props().diff:find('累计调整') and props().diff:find('没有全局参数变化'))
            dialog.windowWillClose(); step()
            recoveryJob.status='previewed'; recoveryJob.canRefine=true
            require('StudioWindow').show(); step(); step()
            props().localMasks=false
            assert(props().maskHint=='继续调整会保留已有蒙版')
        ''')

    def test_recovered_rollback_failure_identifies_copy_and_remains_visible(self):
        self.run_lua("dialog.windowWillClose();step();preferences.lastJobId='00000000-0000-0000-0000-000000000001';recoveryJob={id=preferences.lastJobId,status='failed',photoId='1',filename='test.raw',title='failed',analysis='',diff='',beforePath='before.jpg',afterPath='',canRestore=true,copyId='77',error='write failed',recoveryError='rollback failed'};require('StudioWindow').show();step();step();assert(props().analysis:find('rollback failed'));assert(props().analysis:find('77'));assert(props().status:find('恢复失败'));assert(props().canRestore)")

    def test_live_failure_callback_preserves_rollback_error(self):
        self.run_lua("button('读取选中照片').action();step();step();props().prompt='soft';button('生成方案').action();step();step();failRecovery=true;button('预览副本').action();step();step();assert(props().analysis:find('rollback failed'));assert(props().analysis:find('77'));assert(props().status:find('恢复失败'));assert(props().canRestore)")

    def test_new_request_error_is_visible_alongside_previous_recovery_warning(self):
        self.run_lua("button('读取选中照片').action();step();step();props().prompt='soft';button('生成方案').action();step();step();failRecovery=true;button('预览副本').action();step();step();offline=true;button('读取选中照片').action();step();assert(props().analysis:find('Host offline'));assert(props().analysis:find('rollback failed'));assert(props().analysis:find('77'));assert(props().canRestore)")

    def test_actual_client_json_and_http_contract(self):
        self.run_lua(r'''
            package.loaded.StudioClient = nil
            local json = require 'JSON'
            local config = json:encode({version=1,url='http://127.0.0.1:12345',token=string.rep('a',64)})
            local sdk = {
                LrPathUtils = {getStandardFilePath=function() return '/home' end,child=function(a,b) return a..'/'..b end},
                LrFileUtils = {exists=function() return true end,readFile=function() return config end},
                LrHttp = {
                    post=function(url,body,headers,method,timeout)
                        assert(url=='http://127.0.0.1:12345/tasks')
                        assert(json:decode(body).action=='capture')
                        assert(headers[1].field=='X-Studio-Token' and #headers[1].value==64)
                        assert(method=='POST' and timeout==8)
                        return '{"state":"running","id":"task"}',{status=202}
                    end,
                    get=function() return '{"ok":true}',{status=200} end,
                },
            }
            import = function(name) return sdk[name] end
            local client = require 'StudioClient'
            assert(client.request('POST','/tasks',{action='capture'}).state=='running')
            assert(client.request('GET','/health').ok)
            sdk.LrHttp.get=function() return '{"id":"job","status":"failed","photoId":"1","error":"write failed","recoveryError":"restore failed","copyId":"77"}',{status=200} end
            local failed=client.request('GET','/jobs/job')
            assert(failed.recoveryError=='restore failed' and failed.copyId=='77')
            sdk.LrHttp.get=function() return '{"error":"not found"}',{status=404} end
            local ok,reason=pcall(function() client.request('GET','/jobs/missing') end)
            assert(not ok and reason=='not found')
            config = json:encode({version=1,url='https://external.example',token=string.rep('a',64)})
            assert(not pcall(client.config))
        ''')

    def test_refinement_requires_render_and_submits_feedback_with_pinned_parent(self):
        self.run_lua("button('读取选中照片').action();step();step();button('生成方案').action();step();step();assert(not props().canRefine);button('预览副本').action();step();step();assert(props().canRefine);props().feedback='阴影再柔和一点';button('继续调整').action();step();step();local sent;for _,call in ipairs(clientCalls) do if call.body and call.body.action=='refine' then sent=call end end;assert(sent.body.jobId=='00000000-0000-0000-0000-000000000001');assert(sent.body.feedback=='阴影再柔和一点');assert(props().feedback=='');assert(not props().canRefine);assert(props().canPreview)")

    def test_saving_style_refreshes_owned_reference_and_new_conversation_keeps_library(self):
        self.run_lua("button('读取选中照片').action();step();step();button('生成方案').action();step();step();assert(not props().canSaveStyle);button('预览副本').action();step();step();assert(props().canSaveStyle);props().styleName='我的海岸';button('保存当前风格').action();step();step();step();assert(props().libraryReferencePath=='owned-reference.jpg');assert(props().librarySummary:find('我的海岸'));button('新会话').action();assert(not props().canGenerate);assert(preferences.lastJobId==nil);assert(props().selectedStyle~='');assert(not props().canApplyStyle)")

    def test_export_uses_selected_style_without_reading_a_photo_and_cancel_sends_no_request(self):
        self.run_lua("""
            step()
            assert(not props().canExportXmp)
            savedStyles={{id='00000000-0000-0000-0000-000000000004', name='海岸',intent='soft',referencePath='',canExportXmp=true}}
            button('刷新').action();step()
            assert(props().canExportXmp and not props().canApplyStyle)
            local before=#clientCalls
            button('导出 XMP…').action();assert(not props().canExportXmp);step()
            assert(#clientCalls==before and props().canExportXmp)
            savePanelPath='C:/Presets/coast.xmp'
            button('导出 XMP…').action();step()
            assert(#clientCalls==before+1)
            assert(clientCalls[#clientCalls].route=='/styles/' .. savedStyles[1].id .. '/xmp')
            assert(clientCalls[#clientCalls].body.output==savePanelPath)
            assert(props().xmpNote:find('已导出 1 项参数'))
            assert(props().photoId==nil and props().canExportXmp)
        """)

    def test_batch_selection_preview_and_reopen(self):
        self.run_lua("""
            step()
            savedStyles={{id='00000000-0000-0000-0000-000000000004',name='海岸',intent='soft',referencePath=''}}
            button('刷新').action();step()
            local before=#clientCalls
            button('为所选照片生成').action()
            assert(#clientCalls==before and props().batchMessage:find('当前选择 1 张'))
            selectedPhotos={{localIdentifier=1},{localIdentifier=2}}
            button('为所选照片生成').action();step()
            local request=clientCalls[#clientCalls]
            assert(request.body.action=='batch-plan' and request.body.photoIds[1]=='1' and request.body.photoIds[2]=='2')
            step();step()
            assert(props().canPreviewBatch and props().canOpenBatchPhoto)
            props().batchPhotoChoice='2'
            assert(props().batchDetail:find('照片离线') and props().batchDetail:find('预览副本') and props().batchDetail:find('恢复副本'))
            assert(not props().canOpenBatchPhoto and not props().batchDetail:find('查看此张'))
            props().batchPhotoChoice='1'
            otherBatch={id='00000000-0000-0000-0000-000000000009',styleName='另一批次',total=2}
            button('刷新').action();step()
            props().batchChoice=otherBatch.id
            assert(not props().canPreviewBatch and not props().canOpenBatchPhoto and props().canOpenBatch)
            assert(props().batchDetail:find('当前加载批次') and props().batchDetail:find('打开批次'))
            before=#clientCalls;button('预览本批方案').action();step();assert(#clientCalls==before)
            props().batchChoice=savedBatch.id
            button('预览本批方案').action();step();step();step()
            assert(not props().canPreviewBatch and props().batchPhotoItems[1].title:find('已预览'))
            button('查看此张').action();step();step()
            assert(props().canRestore)
            assert(props().batchDetail:find('上方显示此张'))
            local second = currentSavedJob()
            second.id='00000000-0000-0000-0000-000000000006';second.photoId='2';preferences.lastJobId=second.id
            savedBatch.items[2]={photoId='2',jobId=second.id,filename='second.raw',status='restored'}
            dialog.windowWillClose();step();require('StudioWindow').show();step();step();step()
            assert(props().batchChoice==savedBatch.id and props().batchPhotoItems[1].title:find('已预览'))
            assert(props().batchPhotoChoice=='2' and props().photoId=='2')
        """)

    def test_open_conversation_uses_latest_job_and_history_is_local_to_selected_round(self):
        self.run_lua("button('读取选中照片').action();step();step();button('生成方案').action();step();step();step();assert(props().canOpenConversation);button('新会话').action();props().conversationChoice='00000000-0000-0000-0000-000000000001';button('打开').action();step();step();assert(props().canPreview);assert(props().historyText:find('Codex'));assert(props().canOpenRevision)")

    def test_opening_earlier_round_resets_transcript_to_its_first_page(self):
        self.run_lua(r'''
            button('读取选中照片').action();step();step()
            button('生成方案').action();step();step();step()
            local first = '00000000-0000-0000-0000-000000000001'
            local second = '00000000-0000-0000-0000-000000000002'
            historyJobs = {
                {id=first,revision=1,status='planned',title='初稿',direction='第一轮意见',adaptation='初稿说明'},
                {id=second,parentJobId=first,revision=2,status='planned',title='调整',direction='第二轮意见',adaptation=string.rep('柔',200)..'末句'}
            }
            recoveryJob = {id=second,parentJobId=first,conversationId=first,revision=2,photoId='1',filename='test.raw',status='planned',title='调整',analysis='更新',diff='Exposure2012: 0 -> 0.2',beforePath='before.jpg',afterPath=''}
            props().revisionChoice=second;button('查看此轮').action();step();step()
            assert(props().historyText:find('第二轮意见'))
            while props().canReadNext do button('下页').action() end
            assert(props().historyText:find('末句'))
            recoveryJob=nil;props().revisionChoice=first;button('查看此轮').action();step();step()
            assert(props().historyPosition=='1 / 1')
            assert(props().historyText:find('第一轮意见'))
            assert(not props().canReadNext and not props().canReadPrevious)
        ''')


if __name__ == '__main__':
    unittest.main()
