"""採点の即時保存・歌唱連動を隔離Chromiumで検証する。"""
import unittest
from playwright.sync_api import expect
import restore_browser

class ScoreTests(restore_browser.RestoreBrowserTests):
    def create_song(self):
        self.page.locator('#btnAdd').click()
        self.page.locator('#inputTitle').fill('採点テスト')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.page.locator('#songList .song-card').click()

    def score(self, value):
        self.page.locator('#inputScore').fill(str(value))
        self.page.locator('#btnAddScore').click()
        expect(self.page.locator('#editModal')).to_be_hidden()

    def test_immediate_save_reload_and_comparison(self):
        self.create_song(); self.score(90)
        expect(self.page.locator('#toast')).to_contain_text('今日うたったに追加')
        self.page.reload()
        self.assertEqual(len(self.snapshot()['songs'][0]['sungDates']),1)
        self.page.locator('#songList .song-card').click()
        self.score(92.5)
        self.page.locator('#songList .song-card').click()
        expect(self.page.locator('#bestScore')).to_contain_text('前回比 +2.5点')
        expect(self.page.locator('#bestScore')).to_contain_text('自己ベスト 92.5点')

    def test_existing_sung_is_linked_and_undo_keeps_it(self):
        self.create_song()
        self.page.locator('#btnSungToday').click()
        self.assertNotEqual(self.page.locator('#scoreSungTarget').input_value(),'new')
        self.score(88)
        self.assertEqual(len(self.snapshot()['songs'][0]['sungDates']),1)
        self.page.locator('#toast button').click()
        self.page.wait_for_function('(async()=> (await DB.getAll())[0].scores.length===0)()')
        self.assertEqual(len(self.snapshot()['songs'][0]['sungDates']),1)

    def test_past_date_edit_and_new_score_undo(self):
        self.create_song()
        self.page.locator('#inputSungDate').fill('2026-01-02T14:30')
        self.score(80)
        self.page.locator('#songList .song-card').click()
        field=self.page.get_by_label('歌った日時を変更')
        field.fill('2026-01-03T15:00');field.press('Tab')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        song=self.snapshot()['songs'][0]
        self.assertEqual(song['scores'][0]['date'],song['sungDates'][0])
        self.page.locator('#songList .song-card').click()
        self.score(85)
        self.page.locator('#toast button').click()
        self.page.wait_for_function('(async()=> (await DB.getAll())[0].scores.length===1)()')
        self.assertEqual(self.snapshot()['songs'][0]['sungDates'],song['sungDates'])

    def test_mobile_unscored_date_and_explicit_new_record(self):
        self.page.set_viewport_size({'width':375,'height':812})
        self.create_song()
        self.page.locator('#btnSungToday').click()
        field=self.page.get_by_label('未採点の歌唱日時')
        field.fill('2026-02-03T12:00'); field.press('Tab')
        self.page.locator('#scoreSungTarget').select_option('new')
        self.page.locator('#inputScore').fill('91')
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        self.page.locator('#btnAddScore').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.assertEqual(len(self.snapshot()['songs'][0]['sungDates']),2)

    def test_save_failure_retains_input_without_history(self):
        self.create_song()
        self.page.evaluate("() => { DB.put=async()=>{throw new DOMException('容量不足','QuotaExceededError')}; }")
        self.page.locator('#inputScore').fill('99')
        self.page.locator('#btnAddScore').click()
        expect(self.page.locator('#toast')).to_contain_text('失敗')
        expect(self.page.locator('#editModal')).to_be_visible()
        self.assertEqual(self.page.locator('#inputScore').input_value(),'99')
        self.assertEqual(self.snapshot()['songs'][0]['scores'],[])
        self.assertEqual(self.snapshot()['songs'][0]['sungDates'],[])

if __name__=='__main__': unittest.main()
