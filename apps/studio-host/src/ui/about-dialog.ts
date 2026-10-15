import { AboutDialog as UpstreamAboutDialog } from '@/upstream/ui';

export class AboutDialog extends UpstreamAboutDialog {
  protected override createBody(): HTMLElement {
    const body = super.createBody();
    const version = body.querySelector('.about-version');

    const hopVersion = document.createElement('div');
    hopVersion.className = 'about-hop-version';
    hopVersion.textContent = `Achmage HOP ${__ACHMAGE_VERSION__} · HOP ${__HOP_VERSION__} 기반`;

    if (version?.parentNode) {
      version.parentNode.insertBefore(hopVersion, version.nextSibling);
    } else {
      body.appendChild(hopVersion);
    }

    // The installer ships THIRD_PARTY_NOTICES.md (not rhwp's repository file the upstream note names).
    const licenseNote = body.querySelector('.about-license-note');
    const notices = '함께 배포하는 오픈소스 구성 요소의 라이선스는 설치 폴더의 THIRD_PARTY_NOTICES.md에 있습니다.';
    if (licenseNote) licenseNote.textContent = notices;
    // Achmage HOP's own notice: trademarks and non-affiliation.
    for (const text of [
      '한글·한컴·HWP·HWPX는 ㈜한글과컴퓨터의 상표 또는 등록 상표입니다. Achmage HOP는 HOP·rhwp를 바탕으로 한 비공식 배포판이며 한글과컴퓨터와 관계가 없습니다.',
      ...(licenseNote ? [] : [notices]),
    ]) {
      const notice = document.createElement('p');
      notice.className = 'about-achmage-notice';
      notice.textContent = text;
      body.appendChild(notice);
    }

    return body;
  }
}
