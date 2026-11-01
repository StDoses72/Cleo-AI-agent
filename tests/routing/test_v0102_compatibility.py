"""Release 0.10.2 draft permissions coexist with our session routing policy."""

import asyncio

import pytest

from cleo.routing.models import RoutingSettings
from tests.desktop.test_task_questions import _service


@pytest.mark.parametrize('mode', ['auto', 'manual'])
def test_draft_keeps_routing_permissions_and_main_model(tmp_path, monkeypatch, mode):
    """Purpose: Guard the merged creation contract without running a model.

    Input: Fake harness, explicit routing mode and draft permission preset.
    Output: Stored mode and native permissions agree; the main model stays selected.
    """
    monkeypatch.setattr('cleo.routing.models.load_policy',
                        lambda _: RoutingSettings(enabled=True))

    async def scenario():
        service, provider, _ = _service(tmp_path)
        service.settings.PROFILE_DIR = tmp_path / 'cleo.json'
        thread = await service.create_thread(
            space='productivity', project_id_value='productivity:general',
            model='gpt-test', routing_mode=mode,
            access='read-only', approval='user',
        )
        manifest = service.store.load_manifest(thread['id'])
        assert manifest['runtime_options']['routing_mode'] == mode
        assert manifest['runtime_options']['model'] == 'gpt-test'
        assert thread['runtime']['routingMode'] == mode
        options = provider.session_options('provider-new')
        assert options.model == 'gpt-test'
        assert (options.sandbox, options.approval_mode) == ('read-only', 'user')
        assert len(provider.brokers) == 1

    asyncio.run(scenario())
