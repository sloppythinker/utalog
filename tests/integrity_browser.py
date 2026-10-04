"""保存競合・復元・日時参照・PWA入力保護の回帰テスト。"""
import json
import sys
import unittest
from pathlib import Path
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import restore_browser


class IntegrityTests(restore_browser.RestoreBrowserTests):
    def seed(self, count=1, memo='', tags=None):
        self.page.evaluate('''async ({count,memo,tags}) => {
            const now=Date.now();
            await DB.bulkPut(Array.from({length:count},(_,i)=>({
                id:'audit-'+i,title:'監査曲'+i,artist:'',memo,tags:tags||[],
                key:0,rating:0,scores:[],sungDates:[],createdAt:now+i,updatedAt:now
            })));
        }''', {'count': count, 'memo': memo, 'tags': tags})
        self.page.reload()
        expect(self.page.locator('#songList .song-card').first).to_be_visible()

    def export_file(self, name):
        self.page.locator('#btnSettings').click()
        with self.page.expect_download() as pending:
            self.page.locator('#btnExport').click()
        file = Path('/tmp') / name
        pending.value.save_as(str(file))
        print('export', file.name, file.stat().st_size, flush=True)
        return file

    def test_other_tab_save_keeps_new_scores(self):
        self.seed()
        other = self.context.new_page()
        other.goto(self.page.url)
        other.locator('#songList .song-card').click()
        self.page.locator('#songList .song-card').click()
        self.page.locator('#inputScore').fill('90')
        self.page.locator('#btnAddScore').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.assertEqual(len(self.snapshot()['songs'][0]['scores']), 1)
        other.locator('#inputMemo').fill('別タブでメモを編集')
        other.locator('#btnSaveEdit').click()
        expect(other.locator('#toast')).to_contain_text('別の画面')
        expect(other.locator('#editModal')).to_be_visible()
        expect(other.locator('#inputMemo')).to_have_value('別タブでメモを編集')
        data = self.snapshot()['songs'][0]
        print('after other tab save', {'scores': data['scores'], 'sungDates': data['sungDates']}, flush=True)
        self.assertEqual(len(data['scores']), 1, '別タブのメモ保存で直前の採点履歴が消えた')

    def test_app_export_over_five_mb_can_be_restored(self):
        self.seed(400, memo='あ' * 5000)
        file = self.export_file('utalog-audit-large-backup.json')
        self.assertGreater(file.stat().st_size, 5 * 1024 * 1024)
        self.assertLess(file.stat().st_size, 20 * 1024 * 1024)
        self.context.close()
        super().setUp()
        self.page.locator('#importFile').set_input_files(str(file))
        expect(self.page.locator('#toast')).to_contain_text('インポート')
        message = self.page.locator('#toast').inner_text()
        print('restore own large backup', message, flush=True)
        self.assertNotIn('失敗', message, '自作の正常なバックアップをサイズ上限で取り込めない')
        self.assertEqual(len(self.snapshot()['songs']), 400)
        self.assertEqual(self.snapshot()['songs'][0]['memo'], 'あ' * 5000)

    def test_song_limit_blocks_addition_without_discarding_input(self):
        self.seed(5000)
        self.page.locator('#btnAdd').click()
        self.page.locator('#inputTitle').fill('5001曲目')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#toast')).to_contain_text('5000曲')
        expect(self.page.locator('#editModal')).to_be_visible()
        expect(self.page.locator('#inputTitle')).to_have_value('5001曲目')
        self.assertEqual(len(self.snapshot()['songs']), 5000)

    def test_concurrent_additions_cannot_exceed_song_limit(self):
        self.seed(4999)
        result = self.page.evaluate('''async () => {
            const results=await Promise.allSettled(['last-a','last-b'].map(id =>
                DB.put({id,title:id}, {expected:null,maxSongs:5000})));
            return {statuses:results.map(r=>r.status), count:(await DB.getAll()).length};
        }''')
        self.assertEqual(result['statuses'].count('fulfilled'), 1)
        self.assertEqual(result['count'], 5000)

    def test_legacy_app_backup_with_5001_songs_can_be_restored(self):
        backup = {'app':'karaoke-repertoire','version':2,
                  'songs':[{'id':f'legacy-{i}','title':f'旧版の曲{i}'} for i in range(5001)]}
        self.page.locator('#importFile').set_input_files({
            'name':'legacy-backup.json','mimeType':'application/json','buffer':json.dumps(backup).encode()})
        expect(self.page.locator('#toast')).to_contain_text('5001曲をインポート')
        self.page.reload()
        self.assertEqual(len(self.snapshot()['songs']), 5001)
        self.page.locator('#btnAdd').click()
        self.page.locator('#inputTitle').fill('復旧後の新規追加')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#toast')).to_contain_text('5000曲')
        self.assertEqual(len(self.snapshot()['songs']), 5001)

    def test_import_total_song_limit_keeps_existing_songs(self):
        self.seed(4999)
        backup = {'songs': [{'title': '新しいA'}, {'title': '新しいB'}]}
        self.page.locator('#importFile').set_input_files({
            'name':'over-limit.json','mimeType':'application/json','buffer':json.dumps(backup).encode()})
        expect(self.page.locator('#toast')).to_contain_text('5000曲')
        self.assertEqual(len(self.snapshot()['songs']), 4999)

    def test_property_order_does_not_cause_false_conflict(self):
        self.seed()
        self.page.locator('#songList .song-card').click()
        self.page.locator('#inputMemo').fill('保存1')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.page.locator('#songList .song-card').click()
        self.page.locator('#inputMemo').fill('保存2')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.page.locator('.sung-quick').click()
        expect(self.page.locator('#toast')).to_contain_text('歌唱記録に追加')
        song = self.snapshot()['songs'][0]
        self.assertEqual(song['memo'], '保存2')
        self.assertEqual(len(song['sungDates']), 1)

    def test_stale_editor_cannot_resurrect_deleted_song(self):
        self.seed()
        other = self.context.new_page()
        other.goto(self.page.url)
        other.locator('#songList .song-card').click()
        self.page.locator('#songList .song-card').click()
        self.page.once('dialog', lambda dialog: dialog.accept())
        self.page.locator('#btnDelete').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        other.locator('#inputMemo').fill('古い画面から保存')
        other.locator('#btnSaveEdit').click()
        expect(other.locator('#toast')).to_contain_text('別の画面')
        expect(other.locator('#inputMemo')).to_have_value('古い画面から保存')
        self.assertEqual(self.snapshot()['songs'], [])

    def test_second_put_failure_does_not_partially_import(self):
        self.page.evaluate('''() => {
            const original=IDBObjectStore.prototype.put;
            let writes=0;
            IDBObjectStore.prototype.put=function(...args) {
                if (this.name==='songs' && ++writes===2) throw new DOMException('途中の保存障害','QuotaExceededError');
                return original.apply(this,args);
            };
        }''')
        backup = {'app': 'karaoke-repertoire', 'version': 2,
                  'songs': [{'id': 'a', 'title': '監査A'}, {'id': 'b', 'title': '監査B'}]}
        self.page.locator('#importFile').set_input_files({
            'name': 'two-songs.json', 'mimeType': 'application/json',
            'buffer': json.dumps(backup).encode()})
        expect(self.page.locator('#toast')).to_contain_text('失敗')
        songs = self.snapshot()['songs']
        print('failed import persisted songs', [s['title'] for s in songs], flush=True)
        self.assertEqual(songs, [], '失敗した復元の先頭の曲だけ保存された')

    def test_score_date_change_keeps_setlist_sung_reference(self):
        self.seed()
        self.page.evaluate('''() => localStorage.setItem('utalog-setlists', JSON.stringify([
            {id:'set',name:'監査セット',createdAt:Date.now(),items:[{id:'audit-0',done:false}]}
        ]))''')
        self.page.reload()
        self.page.locator('#tabSetlist').click()
        self.page.locator('#plList .pl-row').click()
        self.page.locator('.sl-check').click()
        expect(self.page.locator('.sl-check')).to_have_class('sl-check on')
        self.page.locator('#tabList').click()
        self.page.locator('#songList .song-card').click()
        self.assertNotEqual(self.page.locator('#scoreSungTarget').input_value(), 'new')
        self.page.locator('#inputScore').fill('90')
        self.page.locator('#btnAddScore').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.page.locator('#songList .song-card').click()
        field = self.page.get_by_label('歌った日時を変更')
        field.fill('2026-01-02T14:30')
        field.press('Tab')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        data = self.snapshot()
        actual = data['setlists'][0]['items'][0]['sungAt']
        expected = data['songs'][0]['sungDates'][0]
        print('setlist sungAt vs changed song date', actual, expected, flush=True)
        self.page.locator('#tabSetlist').click()
        self.page.locator('.sl-check').click()
        expect(self.page.locator('.sl-check.on')).to_have_count(0)
        after = self.snapshot()
        print('sung dates left after unchecking changed-date entry', after['songs'][0]['sungDates'], flush=True)
        self.assertEqual(after['songs'][0]['sungDates'], [], '日時変更後に完了を戻しても該当する歌唱履歴が残った')

    def test_initial_service_worker_does_not_discard_unsaved_input(self):
        self.context.close()
        self.context = self.browser.new_context(service_workers='allow')
        self.context.route('**/*', lambda route: route.continue_() if route.request.url.startswith('http://127.0.0.1:') else route.abort())
        delayed = ('self.addEventListener("install",e=>e.waitUntil(new Promise(r=>setTimeout(r,2000))));\n'
                   + (ROOT / 'sw.js').read_text())
        self.context.route('**/sw.js', lambda route: route.fulfill(content_type='application/javascript', body=delayed))
        self.page = self.context.new_page()
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}')
        self.page.locator('#btnAdd').click()
        self.page.locator('#inputTitle').fill('入力中の曲')
        self.page.wait_for_function('navigator.serviceWorker.controller !== null', timeout=10000)
        self.page.wait_for_timeout(500)
        print('after initial SW activation', {'value': self.page.locator('#inputTitle').input_value(),
              'modal_visible': self.page.locator('#editModal').is_visible()}, flush=True)
        expect(self.page.locator('#inputTitle')).to_have_value('入力中の曲')

    def prepare_date_edit(self, scored=True):
        self.seed()
        self.page.evaluate('''async scored => {
            const song=(await DB.getAll())[0];
            const date=Date.now();
            song.sungDates=[date];
            song.scores=scored ? [{score:90,date}] : [];
            await DB.put(song);
            localStorage.setItem('utalog-setlists',JSON.stringify([
                {id:'set',name:'参照テスト',createdAt:date,items:[{id:song.id,done:true,sungAt:date}]}
            ]));
        }''', scored)
        self.page.reload()
        before=self.snapshot()
        self.page.locator('#songList .song-card').click()
        field=self.page.get_by_label('歌った日時を変更' if scored else '未採点の歌唱日時')
        field.fill('2026-01-02T14:30')
        field.press('Tab')
        return before

    def test_date_edit_setlist_failure_preserves_song_and_reference(self):
        before=self.prepare_date_edit()
        self.page.evaluate('''() => {
            const original=Storage.prototype.setItem;
            Storage.prototype.setItem=function(key,value) {
                if(key==='utalog-setlists') throw new DOMException('容量不足','QuotaExceededError');
                return original.call(this,key,value);
            };
        }''')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#toast')).to_contain_text('失敗')
        expect(self.page.locator('#editModal')).to_be_visible()
        self.assertEqual(self.snapshot(),before)

    def test_date_edit_song_failure_restores_reference(self):
        before=self.prepare_date_edit()
        self.page.evaluate("() => { DB.put=async()=>{throw new Error('保存障害')}; }")
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#toast')).to_contain_text('失敗')
        expect(self.page.locator('#editModal')).to_be_visible()
        self.assertEqual(self.snapshot(),before)

    def test_unscored_date_edit_updates_reference(self):
        self.prepare_date_edit(scored=False)
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        data=self.snapshot()
        self.assertEqual(data['songs'][0]['sungDates'][0],data['setlists'][0]['items'][0]['sungAt'])

    def test_repeated_date_edits_update_reference_to_final_date(self):
        self.prepare_date_edit()
        field=self.page.get_by_label('歌った日時を変更')
        field.fill('2026-01-03T14:30')
        field.press('Tab')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        data=self.snapshot()
        self.assertEqual(data['songs'][0]['sungDates'][0],data['setlists'][0]['items'][0]['sungAt'])

    def test_backup_over_twenty_mb_is_rejected(self):
        self.page.locator('#importFile').set_input_files({
            'name':'too-large.json','mimeType':'application/json','buffer':b' '*(20*1024*1024+1)})
        expect(self.page.locator('#toast')).to_contain_text('上限（20MB）')
        self.assertEqual(self.snapshot()['songs'],[])

    def test_service_worker_update_waits_for_edit_to_be_saved(self):
        self.context.close()
        self.context = self.browser.new_context(service_workers='allow')
        self.context.route('**/*', lambda route: route.continue_() if route.request.url.startswith('http://127.0.0.1:') else route.abort())
        revision = [0]
        source = (ROOT / 'sw.js').read_text()
        self.context.route('**/sw.js', lambda route: route.fulfill(
            content_type='application/javascript', body=f'// test revision {revision[0]}\n' + source,
            headers={'Cache-Control':'no-store'}))
        self.page = self.context.new_page()
        self.page.goto(f'http://127.0.0.1:{self.server.server_port}')
        self.page.wait_for_function('navigator.serviceWorker.controller?.state === "activated"')
        self.page.locator('#btnAdd').click()
        self.page.locator('#inputTitle').fill('更新中でも残る曲')
        revision[0] = 1
        self.page.evaluate('navigator.serviceWorker.getRegistration().then(r=>r.update())')
        expect(self.page.locator('#toast button')).to_have_text('更新する')
        self.page.locator('#toast button').click()
        expect(self.page.locator('#toast')).to_contain_text('保存または閉じた後')
        expect(self.page.locator('#inputTitle')).to_have_value('更新中でも残る曲')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#songList .song-card')).to_contain_text('更新中でも残る曲')
        self.page.wait_for_function('document.querySelector("#editModal").classList.contains("hidden")')
        self.assertEqual(self.snapshot()['songs'][0]['title'], '更新中でも残る曲')


if __name__ == '__main__':
    unittest.main()
