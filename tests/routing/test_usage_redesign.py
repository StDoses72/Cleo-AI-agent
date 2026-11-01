"""Model-specific capacity, reported costs, semantic labels and safe worker handoffs."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from cleo.desktop.presenters import usage_from_events
from cleo.routing.catalog import atomic_json
from cleo.routing.tools import tool_functions
from cleo.runtime.context_capacity import context_capacity
from cleo.runtime.task_tracking import label_task
from cleo.runtime.task_usage import event_usage, task_usage


def test_capacity_uses_model_metadata_and_resets_old_context(tmp_path, monkeypatch):
    monkeypatch.setattr('cleo.integrations.harness_home.harness_home', lambda *a, **k: tmp_path)
    atomic_json(tmp_path / 'models_cache.json', {'models': [
        {'slug': 'small', 'context_window': 128000, 'effective_context_window_percent': 95},
        {'slug': 'large', 'context_window': 272000, 'effective_context_window_percent': 95}]})
    settings = SimpleNamespace(MEMORY_DIR=tmp_path)
    assert context_capacity(settings, 'small', 'codex') == 121600
    assert context_capacity(settings, 'large', 'codex') == 258400
    assert context_capacity(settings, 'unknown', 'codex') == 0
    events = [{'data': {'tokenUsage': {'last': {'totalTokens': 100},
                                    'modelContextWindow': 121600}}},
              {'type': 'context_model_changed', 'data': {'model': 'large'}}]
    assert usage_from_events(events, 258400) == {
        'used': None, 'limit': 258400, 'input': None, 'output': None}
    assert usage_from_events([], 0)['limit'] == 0


def test_reported_cost_and_cache_are_counted_once_and_missing_is_not_zero():
    event = {'type': 'usage', 'id': 'one', 'data': {'call_id': 'one', 'usage': {
        'input_tokens': 100, 'output_tokens': 10, 'cache_read_input_tokens': 80,
        'cache_creation_input_tokens': 20}, 'total_cost_usd': .002}}
    result = event_usage([event, event])
    assert result['input'] == 200 and result['total'] == 210
    assert result['cacheRead'] == 80 and result['cacheWrite'] == 20
    assert result['reportedCostUsd'] == .002
    assert event_usage([{'type': 'user_message'}])['reportedCostUsd'] is None


def test_semantic_label_uses_existing_tool_and_does_not_change_task_or_model(service_factory):
    async def scenario():
        service, providers = service_factory(policy={'enabled': False})
        store = service.store
        store.update_manifest('parent', usage_task_id='work_label')
        store.append_event(session_id='parent', space='non_productivity', project='project',
                           event_type='task_boundary', actor='system', data={
                               'task_id': 'work_label', 'number': 1, 'status': 'initial',
                               'abstract': '帮我讲解下这个stm的作业是怎么做的',
                               'abstract_source': 'request_excerpt', 'model': 'main-model'})
        label = tool_functions(lambda: 'parent', lambda _: service)[-1]
        assert (await label('STM 作业讲解'))['status'] == 'labelled'
        assert (await label('其他内容'))['status'] == 'already_labelled'
        assert task_usage(store, 'parent')['title'] == 'STM 作业讲解'
        assert store.load_manifest('parent')['usage_task_id'] == 'work_label'
        assert store.load_manifest('parent')['runtime_options']['model'] == 'main-model'
        assert not any(provider.prompts for provider in providers)
        with pytest.raises(ValueError):
            label_task(store, 'parent', 'x' * 41)
    asyncio.run(scenario())


def test_full_delegate_handoff_to_different_worker_and_unknown_acceptance(
    service_factory, assessment,
):
    async def scenario():
        service, providers = service_factory()
        first = await service.delegate('implement part one', {**assessment, 'part': '实现'})
        artifact = service._project('.') / 'result.txt'
        artifact.write_text('verified fixture artifact', encoding='utf-8')
        second = await service.delegate('verify part two', {**assessment, 'part': '测试'},
            {'provider': 'strong'}, handoff={'task_id': first['task_id'],
                'summary': 'Implementation is ready for verification', 'artifacts': ['result.txt']})
        assert second['status'] == 'completed' and second['acceptance'] == 'unknown'
        assert len(providers[0].prompts) == len(providers[1].prompts) == 1
        assert 'Prior worker handoff' in providers[1].prompts[0][1]
        record_path = service.state_path / 'tasks' / (second['task_id'] + '.json')
        record = json.loads(record_path.read_text(encoding='utf-8'))
        assert record['handoff']['task_id'] == first['task_id']
        assert 'Implementation is ready' not in json.dumps(record)
        assert service.store.load_manifest('parent')['runtime_options']['model'] == 'main-model'
        for bad in ({'task_id': first['task_id'], 'summary': 'bad', 'artifacts': ['../outside']},):
            with pytest.raises(ValueError):
                await service.delegate('must not run', assessment, handoff=bad)
        assert len(providers[0].prompts) == len(providers[1].prompts) == 1
    asyncio.run(scenario())


def test_mcp_handoff_checks_parent_and_current_goal(service_factory, assessment, monkeypatch):
    from fastmcp import Client, FastMCP

    from cleo.routing import tools
    from cleo.routing.scope import parent_binding_path

    async def scenario():
        service, providers = service_factory()
        key = 'd' * 32
        atomic_json(parent_binding_path(service.store.memory_root, key), {'session_id': 'parent'})
        monkeypatch.setattr(tools, 'create_service', lambda *args, **kwargs: service)
        server = FastMCP('offline-handoff')
        tools.register_mcp_tools(server, service.store.memory_root, key)
        async with Client(server) as client:
            first = (await client.call_tool('delegate_subtask', {
                'prompt': 'first part', 'assessment': assessment})).data
            second = (await client.call_tool('delegate_subtask', {
                'prompt': 'second part', 'assessment': {**assessment, 'part': '测试'},
                'selection': {'provider': 'strong'},
                'handoff': {'task_id': first['task_id'], 'summary': 'Review previous evidence'},
            })).data
            assert second['status'] == 'completed' and second['acceptance'] == 'unknown'
            assert len(providers[0].prompts) == len(providers[1].prompts) == 1
            service.store.update_manifest('parent', usage_task_id='different_goal')
            rejected = await client.call_tool('delegate_subtask', {
                'prompt': 'must not run', 'assessment': assessment,
                'handoff': {'task_id': first['task_id'], 'summary': 'stale handoff'},
            })
            assert rejected.data['status'] == 'rejected'
            assert len(providers[0].prompts) == len(providers[1].prompts) == 1
    asyncio.run(scenario())


def test_cost_can_be_reported_even_when_token_counters_are_missing():
    result = event_usage([{'type': 'usage', 'data': {
        'call_id': 'cost-only', 'total_cost_usd': .007}}])
    assert result['total'] is None and result['reportedCostUsd'] == .007
    assert result['complete'] is False
