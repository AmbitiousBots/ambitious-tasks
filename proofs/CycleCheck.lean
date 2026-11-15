module

public import Mathlib.Data.Finset.Basic
public import Mathlib.Data.Fintype.Card
public import Mathlib.Data.Fintype.Fin
public import Mathlib.Logic.Relation
public import Mathlib.Order.WellFounded
public import Mathlib.Order.Fin.Basic

import all Mathlib.Data.Finset.Defs
import all Mathlib.Data.Multiset.Defs
import all Mathlib.Data.Finset.Insert
import all Mathlib.Data.Finset.Filter
import all Mathlib.Data.Multiset.FinsetOps
import all Mathlib.Data.Multiset.Filter

public section

namespace CycleCheck

local instance {α : Type*} : Membership α (Finset α) := ⟨fun s a => a ∈ s.val⟩

local instance {α : Type*} [DecidableEq α] (a : α) (s : Finset α) :
    Decidable (a ∈ s) := Multiset.decidableMem a s.val

abbrev Graph (n : ℕ) := Finset (Fin n × Fin n)

variable {n : ℕ}

def dependsOn (g : Graph n) (task prerequisite : Fin n) : Prop :=
  (task, prerequisite) ∈ g

def reachable (g : Graph n) (a b : Fin n) : Prop :=
  Relation.TransGen (dependsOn g) a b

def acyclic (g : Graph n) : Prop :=
  ∀ a, ¬ reachable g a a

def addDep_ok (g : Graph n) (a b : Fin n) : Prop :=
  ¬ reachable g b a ∧ a ≠ b

theorem reachable_insert_of_reachable {g : Graph n} {a b x y : Fin n}
    (h : reachable g x y) : reachable (insert (a, b) g) x y :=
  Relation.TransGen.mono (fun _ _ hxy => Multiset.mem_ndinsert.mpr (Or.inr hxy)) _ _ h

theorem reachable_insert_split {g : Graph n} {a b x y : Fin n}
    (h : reachable (insert (a, b) g) x y) :
    reachable g x y ∨
      (Relation.ReflTransGen (dependsOn g) x a ∧ Relation.ReflTransGen (dependsOn g) b y) := by
  induction h with
  | single hxy =>
    rcases Multiset.mem_ndinsert.mp hxy with heq | hmem
    · obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
      exact Or.inr ⟨Relation.ReflTransGen.refl, Relation.ReflTransGen.refl⟩
    · exact Or.inl (Relation.TransGen.single hmem)
  | tail _ hcy ih =>
    rcases Multiset.mem_ndinsert.mp hcy with heq | hmem
    · obtain ⟨rfl, rfl⟩ := Prod.mk.inj heq
      rcases ih with hxc | ⟨hxa, _⟩
      · exact Or.inr ⟨hxc.to_reflTransGen, Relation.ReflTransGen.refl⟩
      · exact Or.inr ⟨hxa, Relation.ReflTransGen.refl⟩
    · rcases ih with hxc | ⟨hxa, hbc⟩
      · exact Or.inl (Relation.TransGen.tail hxc hmem)
      · exact Or.inr ⟨hxa, Relation.ReflTransGen.tail hbc hmem⟩

theorem addDep_ok_iff {g : Graph n} (hg : acyclic g) (a b : Fin n) :
    addDep_ok g a b ↔ acyclic (insert (a, b) g) := by
  constructor
  · rintro ⟨hba, hab⟩ x hxx
    rcases reachable_insert_split hxx with h | ⟨hxa, hbx⟩
    · exact hg x h
    · rcases Relation.reflTransGen_iff_eq_or_transGen.mp (hbx.trans hxa) with heq | hreach
      · exact hab heq
      · exact hba hreach
  · intro hacyclic
    have hedge : reachable (insert (a, b) g) a b :=
      Relation.TransGen.single (Multiset.mem_ndinsert.mpr (Or.inl rfl))
    refine ⟨fun hba => ?_, fun hab => ?_⟩
    · exact hacyclic a (hedge.trans (reachable_insert_of_reachable hba))
    · subst hab
      exact hacyclic a hedge

theorem addDep_ok_iff_not_reflReachable {g : Graph n} (hg : acyclic g) (a b : Fin n) :
    acyclic (insert (a, b) g) ↔ ¬ Relation.ReflTransGen (dependsOn g) b a := by
  rw [← addDep_ok_iff hg, Relation.reflTransGen_iff_eq_or_transGen]
  unfold addDep_ok reachable
  tauto

theorem acyclic_erase {g : Graph n} (hg : acyclic g) (e : Fin n × Fin n) :
    acyclic (g.erase e) :=
  fun x hxx => hg x (Relation.TransGen.mono (fun _ _ h => Finset.mem_of_mem_erase h) _ _ hxx)

theorem acyclic_empty : acyclic (∅ : Graph n) := by
  intro x hxx
  rcases Relation.TransGen.head'_iff.mp hxx with ⟨_, hedge, _⟩
  exact absurd hedge (Finset.notMem_empty _)

def unblocked (g : Graph n) (done : Finset (Fin n)) (task : Fin n) : Prop :=
  ∀ prerequisite, dependsOn g task prerequisite → prerequisite ∈ done

instance (g : Graph n) (done : Finset (Fin n)) (task : Fin n) :
    Decidable (unblocked g done task) :=
  inferInstanceAs (Decidable (∀ prerequisite, (task, prerequisite) ∈ g → prerequisite ∈ done))

def next (g : Graph n) (candidates done : Finset (Fin n)) : Finset (Fin n) :=
  candidates.filter (fun task => task ∉ done ∧ unblocked g done task)

theorem mem_next_iff {g : Graph n} {candidates done : Finset (Fin n)} {task : Fin n} :
    task ∈ next g candidates done ↔
      task ∈ candidates ∧ task ∉ done ∧ ∀ p, (task, p) ∈ g → p ∈ done := by
  exact Multiset.mem_filter

theorem next_sound {g : Graph n} {candidates done : Finset (Fin n)} {task prerequisite : Fin n}
    (hnext : task ∈ next g candidates done) (hdep : (task, prerequisite) ∈ g) :
    prerequisite ∈ done :=
  (mem_next_iff.mp hnext).2.2 prerequisite hdep

theorem next_nonempty_of_acyclic {g : Graph n} (hg : acyclic g)
    {candidates done : Finset (Fin n)}
    (hclosed : ∀ t p, t ∈ candidates → (t, p) ∈ g → p ∈ candidates)
    (hopen : ∃ t ∈ candidates, t ∉ done) :
    (next g candidates done).Nonempty := by
  classical
  let prerequisiteOf : Fin n → Fin n → Prop := fun p t => reachable g t p
  have : IsTrans (Fin n) prerequisiteOf := ⟨fun _ _ _ hab hbc => Relation.TransGen.trans hbc hab⟩
  have : Std.Irrefl prerequisiteOf := ⟨fun a h => hg a h⟩
  have hwf : WellFounded prerequisiteOf := Finite.wellFounded_of_trans_of_irrefl prerequisiteOf
  obtain ⟨t, ⟨htc, htd⟩, hmin⟩ :=
    hwf.has_min {t | t ∈ candidates ∧ t ∉ done} hopen
  refine ⟨t, mem_next_iff.mpr ⟨htc, htd, fun p hp => ?_⟩⟩
  by_contra hpd
  exact hmin p ⟨hclosed t p htc hp, hpd⟩ (Relation.TransGen.single hp)

/-- info: 'CycleCheck.addDep_ok_iff' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms addDep_ok_iff

/-- info: 'CycleCheck.addDep_ok_iff_not_reflReachable' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms addDep_ok_iff_not_reflReachable

/-- info: 'CycleCheck.next_sound' depends on axioms: [propext, Quot.sound] -/
#guard_msgs in
#print axioms next_sound

/-- info: 'CycleCheck.next_nonempty_of_acyclic' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in
#print axioms next_nonempty_of_acyclic

end CycleCheck
