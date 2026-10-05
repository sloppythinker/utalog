"""曲画像の表示・復旧と非同期保存の保全を実Chromiumで検証する。"""
import base64
import unittest
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import expect
import restore_browser

RELEASE = '51fe5010-038e-4113-9b76-66b4ffcf1fe0'
COVER = f'https://coverartarchive.org/release/{RELEASE}/front-250'
APPLE_COVER = 'https://images.example.test/cherry.png'
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=')


class ArtworkTests(restore_browser.RestoreBrowserTests):
    def setUp(self):
        super().setUp()
        self.apple_status = 503
        self.apple_results = []
        self.recordings = [{'title': 'チェリー', 'artist-credit': [{'name': 'スピッツ'}],
                            'releases': [{'id': RELEASE}]}]
        self.musicbrainz_calls=[]
        self.context.route('https://itunes.apple.com/**', lambda route: route.fulfill(
            status=self.apple_status, json={'results': self.apple_results}))
        def musicbrainz(route):
            self.musicbrainz_calls.append(parse_qs(urlparse(route.request.url).query))
            route.fulfill(json={'recordings': self.recordings, 'artists': [{'name': 'スピッツ'}]})
        self.context.route('https://musicbrainz.org/**', musicbrainz)
        self.context.route('https://coverartarchive.org/**', lambda route: route.fulfill(
            content_type='image/png', body=PNG))
        self.context.route('https://images.example.test/**', lambda route: route.fulfill(
            content_type='image/png', body=PNG))

    def open_add(self):
        self.page.locator('#btnAdd').click()
        self.page.wait_for_timeout(300)

    def seed(self, url=''):
        self.page.evaluate('''async url => {
            await DB.put({id:'art-song', title:'チェリー', artist:'スピッツ', artworkUrl:url,
                memo:'元のメモ',key:0,rating:0,tags:[],scores:[],sungDates:[],createdAt:1,updatedAt:1});
        }''', url)
        self.page.reload()
        expect(self.page.locator('#songList .song-card')).to_be_visible()

    def wait_image(self, selector):
        self.page.wait_for_function('''selector => {
            const image=document.querySelector(selector);
            return image && image.complete && image.naturalWidth>0;
        }''', arg=selector, timeout=15000)

    def test_fallback_candidates_show_cover(self):
        self.open_add()
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox .suggest-item')).to_be_visible()
        self.wait_image('#suggestBox img.suggest-art')
        expect(self.page.locator('#suggestBox img.suggest-art')).to_have_attribute('src', COVER)

    def test_fallback_cover_is_saved_and_survives_reload(self):
        self.open_add()
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox .suggest-item')).to_be_visible()
        self.wait_image('#suggestBox img.suggest-art')
        self.page.locator('#suggestBox .suggest-item').click()
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.page.reload()
        self.wait_image('#songList img.song-art')
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'], COVER)

    def test_duplicate_candidate_keeps_available_cover(self):
        self.open_add()
        self.page.evaluate('''cover => {
            document.querySelector('#inputArtist').value='スピッツ';
            ITunes.search=async term => term.startsWith('スピッツ ')
                ? [{title:'チェリー',artist:'スピッツ',artworkUrl:''}]
                : [{title:'チェリー',artist:'スピッツ',artworkUrl:cover}];
        }''', APPLE_COVER)
        self.page.locator('#inputTitle').fill('チェリー')
        expect(self.page.locator('#suggestBox .suggest-item')).to_have_count(1)
        self.wait_image('#suggestBox img.suggest-art')
        expect(self.page.locator('#suggestBox img.suggest-art')).to_have_attribute('src', APPLE_COVER)

    def test_reselecting_imageless_same_song_keeps_saved_cover(self):
        self.seed(APPLE_COVER)
        self.page.locator('#songList .song-card').click()
        self.page.evaluate("ITunes.search=async()=>[{title:'チェリー',artist:'スピッツ',artworkUrl:''}]")
        self.page.locator('#inputTitle').fill('チェ')
        self.page.locator('#suggestBox .suggest-item').click()
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'], APPLE_COVER)

    def test_existing_imageless_song_recovers_without_manual_save(self):
        self.apple_status=200
        self.apple_results=[{'trackName':'チェリー','artistName':'スピッツ','artworkUrl100':APPLE_COVER}]
        self.seed()
        self.wait_image('#songList img.song-art')
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'], APPLE_COVER)

    def test_artist_image_has_independent_fallback(self):
        result=self.page.evaluate("ITunes.artistImage('スピッツ')")
        self.assertEqual(result, COVER)

    def test_broken_saved_image_recovers(self):
        self.apple_status=200
        self.apple_results=[{'trackName':'チェリー','artistName':'スピッツ','artworkUrl100':APPLE_COVER}]
        self.context.route('https://broken.example.test/**', lambda route: route.fulfill(status=404))
        self.seed('https://broken.example.test/old.png')
        self.wait_image('#songList img.song-art')
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'], APPLE_COVER)

    def test_cover_retries_other_release_when_first_image_is_missing(self):
        second='6a8e4933-ab6a-4ad0-9951-2d990e64140d'
        self.recordings[0]['releases'].append({'id':second})
        self.context.route(COVER, lambda route: route.fulfill(status=404))
        self.open_add()
        self.page.locator('#inputTitle').fill('チェリー')
        self.wait_image('#suggestBox img.suggest-art')
        self.page.locator('#suggestBox .suggest-item').click()
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'],
                         f'https://coverartarchive.org/release/{second}/front-250')

    def test_background_recovery_keeps_dirty_edit_and_allows_save(self):
        self.page.add_init_script('''window.addEventListener('DOMContentLoaded', () => {
            ITunes.songImage=()=>new Promise(resolve=>window.resolveArt=resolve);
        });''')
        self.seed()
        self.page.wait_for_function('typeof resolveArt === "function"')
        self.page.locator('#songList .song-card').click()
        self.page.locator('#inputMemo').fill('編集中のメモ')
        self.page.evaluate('resolveArt(' + repr(APPLE_COVER) + ')')
        self.wait_image('#songList img.song-art')
        expect(self.page.locator('#inputMemo')).to_have_value('編集中のメモ')
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        song=self.snapshot()['songs'][0]
        self.assertEqual(song['memo'],'編集中のメモ')
        self.assertEqual(song['artworkUrl'],APPLE_COVER)

    def test_artwork_update_preserves_newer_scores(self):
        self.page.evaluate('''async cover => {
            const original={id:'race',title:'チェリー',artist:'スピッツ',artworkUrl:'',scores:[]};
            await DB.put(original);
            await DB.put({...original,scores:[{date:1,score:98}],sungDates:[1],memo:'新しいメモ'});
            await DB.updateArtwork(original,cover);
        }''',APPLE_COVER)
        song=self.snapshot()['songs'][0]
        self.assertEqual(song['scores'],[{'date':1,'score':98}])
        self.assertEqual(song['sungDates'],[1])
        self.assertEqual(song['memo'],'新しいメモ')
        self.assertEqual(song['artworkUrl'],APPLE_COVER)

    def test_artwork_update_does_not_resurrect_deleted_or_overwrite_renamed_song(self):
        result=self.page.evaluate('''async cover => {
            const original={id:'race',title:'チェリー',artist:'スピッツ',artworkUrl:''};
            await DB.put(original);
            await DB.remove(original.id);
            const deleted=await DB.updateArtwork(original,cover);
            await DB.put({...original,title:'ロビンソン'});
            const renamed=await DB.updateArtwork(original,cover);
            return {deleted,renamed};
        }''',APPLE_COVER)
        self.assertEqual(result,{'deleted':None,'renamed':None})
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'],'')

    def test_image_lookup_does_not_use_other_artist(self):
        self.apple_status=200
        self.apple_results=[{'trackName':'チェリー','artistName':'別の歌手','artworkUrl100':APPLE_COVER}]
        self.recordings=[]
        self.assertEqual(self.page.evaluate("ITunes.songImage('チェリー','スピッツ')"),'')

    def test_failed_recovery_can_retry_when_connection_returns(self):
        self.recordings=[]
        self.seed()
        self.page.wait_for_function("JSON.parse(localStorage.getItem('utalog-diagnostics')||'[]').length>=0")
        self.page.wait_for_timeout(1500)
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'],'')
        self.apple_status=200
        self.apple_results=[{'trackName':'チェリー','artistName':'スピッツ','artworkUrl100':APPLE_COVER}]
        self.page.evaluate("window.dispatchEvent(new Event('online'))")
        self.wait_image('#songList img.song-art')

    def test_artist_field_shows_songs_and_selects_title_and_cover(self):
        self.apple_status=200
        self.apple_results=[{'trackName':'チェリー','artistName':'スピッツ','artworkUrl100':APPLE_COVER}]
        self.open_add()
        self.page.locator('#inputArtist').fill('スピッツ')
        row=self.page.locator('#suggestBoxArtist .suggest-song-item')
        expect(row).to_be_visible()
        self.wait_image('#suggestBoxArtist .suggest-song-item img')
        row.click()
        expect(self.page.locator('#inputTitle')).to_have_value('チェリー')
        expect(self.page.locator('#inputArtist')).to_have_value('スピッツ')
        expect(self.page.locator('#suggestBoxArtist')).to_be_hidden()
        self.page.locator('#btnSaveEdit').click()
        expect(self.page.locator('#editModal')).to_be_hidden()
        self.assertEqual(self.snapshot()['songs'][0]['artworkUrl'],APPLE_COVER)

    def test_artist_field_fallback_returns_that_artists_songs(self):
        self.recordings.append({'title':'チェリー','artist-credit':[{'name':'別の歌手'}]})
        self.open_add()
        self.page.locator('#inputArtist').fill('スピッツ')
        rows=self.page.locator('#suggestBoxArtist .suggest-song-item')
        expect(rows).to_have_count(1,timeout=10000)
        expect(rows).to_contain_text('スピッツ')
        self.assertTrue(any(call.get('query')==['artist:"スピッツ"'] for call in self.musicbrainz_calls))

    def test_artist_name_candidate_uses_available_song_cover_in_fallback(self):
        self.open_add()
        self.page.locator('#inputArtist').fill('スピッツ')
        self.wait_image('#suggestBoxArtist .suggest-item img')
        expect(self.page.locator('#suggestBoxArtist .suggest-item img')).to_have_attribute('src',COVER)

    def test_artist_name_in_title_field_searches_artist_in_fallback(self):
        self.open_add()
        self.page.locator('#inputTitle').fill('スピッツ')
        expect(self.page.locator('#suggestBox .suggest-item')).to_contain_text('チェリー')
        self.assertIn('artist:"スピッツ"', self.musicbrainz_calls[0]['query'][0])

    def test_early_artist_tracks_remain_selectable_while_names_wait(self):
        self.open_add()
        self.page.evaluate('''cover => {
            ITunes.searchArtists=()=>new Promise(()=>{});
            ITunes.searchByArtist=async()=>[{title:'チェリー',artist:'スピッツ',artworkUrl:cover}];
        }''',APPLE_COVER)
        self.page.locator('#inputArtist').fill('スピッツ')
        self.page.locator('#suggestBoxArtist .suggest-song-item').click(timeout=2000)
        expect(self.page.locator('#inputTitle')).to_have_value('チェリー')
        expect(self.page.locator('#suggestBoxArtist')).to_be_hidden()

    def test_stale_artist_songs_cannot_replace_new_input(self):
        self.open_add()
        self.page.evaluate('''() => {
            ITunes.searchArtists=async()=>[];
            window.artistPending=[];
            ITunes.searchByArtist=()=>new Promise(resolve=>artistPending.push(resolve));
        }''')
        self.page.locator('#inputArtist').fill('古い歌手')
        self.page.wait_for_function('artistPending.length===1')
        self.page.locator('#inputArtist').fill('新しい歌手')
        self.page.wait_for_function('artistPending.length===2')
        self.page.evaluate("artistPending[1]([{title:'新しい曲',artist:'新しい歌手',artworkUrl:''}])")
        expect(self.page.locator('#suggestBoxArtist')).to_contain_text('新しい曲')
        self.page.evaluate("artistPending[0]([{title:'古い曲',artist:'古い歌手',artworkUrl:''}])")
        expect(self.page.locator('#suggestBoxArtist')).not_to_contain_text('古い曲')


if __name__ == '__main__': unittest.main()
