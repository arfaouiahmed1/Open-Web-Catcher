"""Validator-stage models (plan task 14, batch W3).

Reserved canonical home for ValidatorAgent models (plan task 24 seam).
Today validation gating is expressed through
``src.orchestrator.emailing.TakedownEmailRenderInput.validator_approved``
(which stays in ``emailing.py``); when dedicated validator result models
appear they belong here and must inherit
``src.models.common.PipelineModel`` (strict, ``extra="forbid"``).
"""
