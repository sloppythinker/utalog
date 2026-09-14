"""曲名・歌手名候補を実Chromiumと模擬APIで検証する（外部通信なし）。"""
import unittest
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import expect
import restore_browser


class SuggestTests(restore_browser.RestoreBrowserTests):
    def setUp(self):
        super().setUp()
        self.page.set_viewport_size({'width': 375, 'height': 812})
        self.apple_calls = []
        self.musicbrainz_calls = []
        self.apple_status = 200
        self.musicbrainz_status = 200
        self.apple_results = [{'trackName': 'チェリー', 'artistName': 'スピッツ'}]
        self.recordings = []
        self.artists = []

        def apple(route):
            self.apple_calls.append(parse_qs(urlparse(route.request.url).query))
            route.fulfill(status=self.apple_status, json={'results': self.apple_results},
                          headers={'Access-Control-Allow-Origin': '*'})

        def musicbrainz(route):
            self.musicbrainz_calls.append(route.request.url)
            route.fulfill(status=self.musicbrainz_status,
                          json={'recordings': self.recordings, 'artists': self.artists},
                          headers={'Access-Control-Allow-Origin': '*'})

        self.context.route('https://itunes.apple.com/**', apple)
        self.context.route('https://musicbrainz.org/**', musicbrainz)
        self.page.locator('#btnAdd').click()
        expect(self.page.locator('#editModal')).to_be_visible()
        # モーダル表示時の遅延フォーカスを待ち、後続の操作を妨げないようにする。
        self.page.wait_for_timeout(300)

    def test_title_candidate_selects_title_and_artist(self):
        self.page.locator('#inputTitle').fill('チェ')
        row = self.page.locator('#suggestBox .suggest-item')
        expect(row).to_have_count(1)
        expect(row).to_contain_text('チェリー')
        row.click()
        expect(self.page.locator('#inputTitle')).to_have_value('チェリー')
        expect(self.page.locator('#inputArtist')).to_have_value('スピッツ')
        expect(self.page.locator('#suggestBox')).to_be_hidden()
        self.assertEqual(len(self.apple_calls), 1)
        self.assertEqual(self.musicbrainz_calls, [])

    def test_artist_and_title_in_one_field_keeps_related_results(self):
        self.page.locator('#inputTitle').fill('スピッツ チェリー')
        expect(self.page.locator('#suggestBox .suggest-item')).to_have_count(1)
        expect(self.page.locator('#suggestBox')).to_contain_text('関連する候補')

    def test_network_failure_is_visible_and_retry_does_not_cache_failure(self):
        self.apple_status = self.musicbrainz_status = 503
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox')).to_contain_text('取得できませんでした', timeout=10000)
        self.apple_status = 200
        self.page.locator('#suggestBox').get_by_role('button', name='再検索').click()
        expect(self.page.locator('#suggestBox .suggest-item')).to_have_count(1)
        self.assertEqual(len(self.apple_calls), 2)

    def test_primary_failure_uses_musicbrainz(self):
        self.apple_status = 503
        self.recordings = [{'title': 'チェリー', 'artist-credit': [{'name': 'スピッツ'}]}]
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox .suggest-item')).to_have_count(1)
        self.assertEqual(len(self.musicbrainz_calls), 1)

    def test_empty_results_show_message(self):
        self.apple_results = []
        self.page.locator('#inputTitle').fill('該当しない曲')
        expect(self.page.locator('#suggestBox')).to_contain_text('見つかりませんでした')

    def test_artist_error_and_retry(self):
        self.apple_status = self.musicbrainz_status = 503
        self.page.locator('#inputArtist').fill('スピッツ')
        expect(self.page.locator('#suggestBoxArtist')).to_contain_text('取得できませんでした', timeout=10000)
        self.apple_status = 200
        self.page.locator('#suggestBoxArtist').get_by_role('button', name='再検索').click()
        expect(self.page.locator('#suggestBoxArtist .suggest-item')).to_contain_text('スピッツ')

    def test_one_search_failure_does_not_discard_successful_candidates(self):
        self.page.evaluate('''() => {
            document.querySelector('#inputArtist').value = 'スピッツ';
            ITunes.search = async term => {
                if (term.startsWith('スピッツ ')) throw new Error('offline');
                return [{title:'チェリー', artist:'スピッツ', artworkUrl:''}];
            };
        }''')
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox .suggest-item')).to_have_count(1)

    def test_clear_input_and_close_modal_ignore_late_results(self):
        self.page.evaluate('''() => {
            window.pendingSuggestions=[];
            ITunes.search=()=>new Promise(resolve=>pendingSuggestions.push(resolve));
        }''')
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox')).to_contain_text('検索中')
        self.page.locator('#inputTitle').fill('')
        self.page.evaluate("pendingSuggestions.shift()([{title:'チェリー',artist:'スピッツ',artworkUrl:''}])")
        expect(self.page.locator('#suggestBox')).to_be_hidden()
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox')).to_contain_text('検索中')
        self.page.once('dialog', lambda dialog: dialog.accept())
        self.page.locator('#btnCancelEdit').click()
        self.page.evaluate("pendingSuggestions.shift()([{title:'チェリー',artist:'スピッツ',artworkUrl:''}])")
        expect(self.page.locator('#suggestBox')).to_be_hidden()
        expect(self.page.locator('#editModal')).to_be_hidden()

    def test_old_same_term_request_cannot_overwrite_new_results(self):
        self.page.evaluate('''() => {
            window.pendingSuggestions=[];
            ITunes.search=()=>new Promise(resolve=>pendingSuggestions.push(resolve));
        }''')
        self.page.locator('#inputTitle').fill('チェリー')
        self.page.wait_for_function('pendingSuggestions.length===1')
        self.page.locator('#inputTitle').fill('別の曲')
        self.page.locator('#inputTitle').fill('チェリー')
        self.page.wait_for_function('pendingSuggestions.length===2')
        self.page.evaluate("pendingSuggestions[1]([{title:'チェリー',artist:'新しい結果',artworkUrl:''}])")
        expect(self.page.locator('#suggestBox')).to_contain_text('新しい結果')
        self.page.evaluate("pendingSuggestions[0]([{title:'チェリー',artist:'古い結果',artworkUrl:''}])")
        expect(self.page.locator('#suggestBox')).not_to_contain_text('古い結果')

    def test_japanese_composition_searches_only_after_confirmation(self):
        self.page.evaluate('''() => {
            const input=document.querySelector('#inputTitle');
            input.value='ちぇ';
            input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));
        }''')
        self.page.wait_for_timeout(500)
        self.assertEqual(self.apple_calls, [])
        self.page.evaluate('''() => {
            const input=document.querySelector('#inputTitle');
            input.value='チェリー';
            input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
        }''')
        expect(self.page.locator('#suggestBox .suggest-item')).to_have_count(1)
        self.assertEqual(len(self.apple_calls), 1)

    def test_offline_message_allows_manual_entry(self):
        self.context.set_offline(True)
        self.page.locator('#inputTitle').fill('手入力の曲')
        expect(self.page.locator('#suggestBox')).to_contain_text('オフライン')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.assertEqual(self.snapshot()['songs'][0]['title'], '手入力の曲')

    def test_musicbrainz_requests_are_spaced_across_title_and_artist(self):
        result = self.page.evaluate('''async () => {
            const calls=[];
            window.fetch=async url=> {
                if (url.includes('itunes.apple.com')) throw new TypeError('offline');
                calls.push(performance.now());
                return new Response(JSON.stringify({recordings:[],artists:[]}));
            };
            await Promise.all([ITunes.search('曲A'),ITunes.searchArtists('歌手B'),ITunes.search('曲C')]);
            return calls;
        }''')
        self.assertEqual(len(result), 3)
        self.assertGreaterEqual(result[1] - result[0], 1000)
        self.assertGreaterEqual(result[2] - result[1], 1000)

    def test_click_outside_cancels_search_before_debounce_fires(self):
        self.page.locator('#inputTitle').fill('チェリー')
        self.page.locator('#inputArtist').click()
        self.page.wait_for_timeout(500)
        self.assertEqual(self.apple_calls, [])
        expect(self.page.locator('#suggestBox')).to_be_hidden()


if __name__ == '__main__':
    unittest.main()
